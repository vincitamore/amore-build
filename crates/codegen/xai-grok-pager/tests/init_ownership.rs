//! Golden ownership/refresh tests for `selene init` (task 0.8).
//!
//! Fixture pack: `tests/fixtures/house-golden/**` (not the live templates stubs).
//! Global hooks registry is isolated via a temp `grok_home` (never `~/.selene`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use xai_grok_pager::house_embed::HouseEntry;
use xai_grok_pager::init_cmd::{
    self, FileAction, HooksRegistryAction, InitArgs, InitContext, MANIFEST_REL,
};

fn golden_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/house-golden")
}

fn load_golden_entries() -> Vec<HouseEntry> {
    init_cmd::entries_from_dir(&golden_source()).expect("load house-golden fixtures")
}

struct Harness {
    _tmp: tempfile::TempDir,
    repo: PathBuf,
    grok_home: PathBuf,
    entries: Vec<HouseEntry>,
}

impl Harness {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        let grok_home = tmp.path().join("fake-selene-home");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&grok_home).unwrap();
        // Minimal git repo so init accepts the root.
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let entries = load_golden_entries();
        assert!(
            !entries.is_empty(),
            "house-golden fixtures must not be empty"
        );
        Self {
            _tmp: tmp,
            repo,
            grok_home,
            entries,
        }
    }

    fn ctx(&self) -> InitContext {
        InitContext {
            cwd: self.repo.clone(),
            grok_home: self.grok_home.clone(),
            entries: self.entries.clone(),
            stdin_is_terminal: false,
        }
    }

    fn run(&self, args: InitArgs) -> init_cmd::InitReport {
        let mut out = Vec::new();
        init_cmd::run_with_context(&args, &self.ctx(), &mut out).expect("init succeeds")
    }

    fn run_expect_err(&self, args: InitArgs) -> String {
        let mut out = Vec::new();
        let err = init_cmd::run_with_context(&args, &self.ctx(), &mut out)
            .expect_err("init should fail");
        format!("{err:#}")
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.repo.join(rel)).unwrap_or_default()
    }

    fn exists(&self, rel: &str) -> bool {
        self.repo.join(rel).exists()
    }

    fn write_user(&self, rel: &str, body: &str) {
        let path = self.repo.join(rel);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    fn list_files(&self) -> BTreeMap<String, Vec<u8>> {
        let mut map = BTreeMap::new();
        collect_files(&self.repo, &self.repo, &mut map);
        // Ignore .git
        map.retain(|k, _| !k.starts_with(".git/") && k != ".git");
        map
    }
}

fn collect_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out);
        } else if path.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(s) => Some(s.to_string_lossy()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            out.insert(rel, std::fs::read(&path).unwrap());
        }
    }
}

fn default_args() -> InitArgs {
    InitArgs {
        yes: true,
        ..InitArgs::default()
    }
}

#[test]
fn fresh_install_writes_tree_and_manifest() {
    let h = Harness::new();
    let report = h.run(default_args());

    assert!(report.wrote_manifest);
    assert!(h.exists(MANIFEST_REL));
    assert!(h.exists("AGENTS.md"));
    assert!(h.exists("context/principle-lattice.md")); // lattice default-on
    assert!(h.exists(".selene/hooks/demo-hook.json"));
    assert!(h.exists(".selene/skills/demo-skill/SKILL.md"));
    assert!(!h.exists(init_cmd::DIOPTRA_NOTE_REL)); // dioptra default-off

    // Every golden source file present with identical bytes.
    for entry in &h.entries {
        let on_disk = std::fs::read(h.repo.join(&entry.rel_path)).unwrap();
        assert_eq!(
            on_disk, entry.contents,
            "mismatch for {}",
            entry.rel_path
        );
    }

    // Manifest covers every written file with matching sha256.
    let manifest = init_cmd::InstallManifest::load(&h.repo.join(MANIFEST_REL))
        .unwrap()
        .expect("manifest present");
    assert_eq!(manifest.version, 1);
    for entry in &h.entries {
        let expected = xai_file_utils::sha256_hex(&entry.contents);
        assert_eq!(
            manifest.files.get(&entry.rel_path).map(String::as_str),
            Some(expected.as_str()),
            "manifest entry for {}",
            entry.rel_path
        );
    }

    // All planned as written on first pass.
    assert!(
        report
            .plans
            .iter()
            .all(|p| p.action == FileAction::Write),
        "fresh install should write every selected file"
    );

    // Hooks registry isolated under fake home.
    let hooks_report = report.hooks_registry.expect("hooks report");
    assert_eq!(hooks_report.action, HooksRegistryAction::Added);
    assert!(hooks_report.registry_path.starts_with(&h.grok_home));
    let reg = std::fs::read_to_string(&hooks_report.registry_path).unwrap();
    assert!(
        reg.lines().any(|l| l.contains(".selene") && l.contains("hooks")),
        "registry should list project hooks dir: {reg}"
    );
}

#[test]
fn idempotent_rerun_reports_no_changes() {
    let h = Harness::new();
    let first = h.run(default_args());
    assert!(first.plans.iter().any(|p| p.action == FileAction::Write));

    let before = h.list_files();
    let second = h.run(default_args());
    let after = h.list_files();

    assert_eq!(before, after, "idempotent rerun must not change the tree");
    assert!(
        second
            .plans
            .iter()
            .all(|p| p.action == FileAction::SkipUnchanged),
        "second run should skip every file: {:?}",
        second
            .plans
            .iter()
            .map(|p| (&p.rel_path, p.action))
            .collect::<Vec<_>>()
    );
    // Hooks already registered.
    assert_eq!(
        second.hooks_registry.unwrap().action,
        HooksRegistryAction::AlreadyPresent
    );
}

#[test]
fn refresh_preserves_user_modified_file() {
    let h = Harness::new();
    h.run(default_args());

    h.write_user("AGENTS.md", "# USER EDITED AGENTS\n");
    let user_body = h.read("AGENTS.md");

    let report = h.run(InitArgs {
        refresh: true,
        yes: true,
        ..InitArgs::default()
    });

    assert_eq!(h.read("AGENTS.md"), user_body, "user edit must be preserved");
    let agents = report
        .plans
        .iter()
        .find(|p| p.rel_path == "AGENTS.md")
        .expect("AGENTS plan");
    assert_eq!(agents.action, FileAction::Preserve);

    // Untouched tool file still matches → refresh may rewrite if template changed.
    // Same template content → SkipUnchanged (content_matches before refresh branch).
    let hook = report
        .plans
        .iter()
        .find(|p| p.rel_path == ".selene/hooks/demo-hook.json")
        .expect("hook plan");
    assert_eq!(hook.action, FileAction::SkipUnchanged);
}

#[test]
fn refresh_rewrites_untouched_when_template_changes() {
    let h = Harness::new();
    h.run(default_args());

    // Simulate a newer binary with updated tool-owned content, same path.
    let mut new_entries = h.entries.clone();
    for e in &mut new_entries {
        if e.rel_path == ".selene/hooks/demo-hook.json" {
            e.contents = b"{\"hooks\":{\"updated\":true}}\n".to_vec();
        }
    }

    let ctx = InitContext {
        cwd: h.repo.clone(),
        grok_home: h.grok_home.clone(),
        entries: new_entries,
        stdin_is_terminal: false,
    };
    let mut out = Vec::new();
    let report = init_cmd::run_with_context(
        &InitArgs {
            refresh: true,
            yes: true,
            ..InitArgs::default()
        },
        &ctx,
        &mut out,
    )
    .unwrap();

    let hook = report
        .plans
        .iter()
        .find(|p| p.rel_path == ".selene/hooks/demo-hook.json")
        .unwrap();
    assert_eq!(hook.action, FileAction::Write);
    assert_eq!(
        h.read(".selene/hooks/demo-hook.json"),
        "{\"hooks\":{\"updated\":true}}\n"
    );
}

#[test]
fn force_overwrites_user_modified() {
    let h = Harness::new();
    h.run(default_args());
    h.write_user("AGENTS.md", "# USER EDITED\n");

    let report = h.run(InitArgs {
        force: true,
        yes: true,
        ..InitArgs::default()
    });

    let agents = report
        .plans
        .iter()
        .find(|p| p.rel_path == "AGENTS.md")
        .unwrap();
    assert_eq!(agents.action, FileAction::Write);
    assert!(
        h.read("AGENTS.md").contains("Golden House AGENTS"),
        "force should restore template"
    );
}

#[test]
fn no_lattice_skips_principle_lattice() {
    let h = Harness::new();
    let report = h.run(InitArgs {
        no_lattice: true,
        yes: true,
        ..InitArgs::default()
    });

    assert!(!h.exists("context/principle-lattice.md"));
    assert!(
        report
            .plans
            .iter()
            .all(|p| p.rel_path != "context/principle-lattice.md")
    );
    assert!(h.exists("context/current-state.md"));
}

#[test]
fn no_skills_skips_skills_tree() {
    let h = Harness::new();
    let report = h.run(InitArgs {
        no_skills: true,
        yes: true,
        ..InitArgs::default()
    });

    assert!(!h.exists(".selene/skills/demo-skill/SKILL.md"));
    assert!(
        report
            .plans
            .iter()
            .all(|p| !p.rel_path.starts_with(".selene/skills/"))
    );
    assert!(h.exists(".selene/hooks/demo-hook.json"));
}

#[test]
fn dry_run_writes_nothing() {
    let h = Harness::new();
    let before = h.list_files();
    let report = h.run(InitArgs {
        dry_run: true,
        yes: true,
        ..InitArgs::default()
    });
    let after = h.list_files();

    assert_eq!(before, after, "dry-run must not create files");
    assert!(!h.exists(MANIFEST_REL));
    assert!(!report.wrote_manifest);
    assert!(
        report
            .plans
            .iter()
            .all(|p| p.action == FileAction::DryRunWrite)
    );
    assert_eq!(
        report.hooks_registry.unwrap().action,
        HooksRegistryAction::DryRunWouldAdd
    );
    // Fake home must not gain a registry either.
    assert!(!h.grok_home.join("hooks-paths").exists());
}

#[test]
fn with_dioptra_plants_pointer_note() {
    let h = Harness::new();
    h.run(InitArgs {
        with_dioptra: true,
        yes: true,
        ..InitArgs::default()
    });
    assert!(h.exists(init_cmd::DIOPTRA_NOTE_REL));
    assert!(h.read(init_cmd::DIOPTRA_NOTE_REL).contains("Dioptra"));
}

#[test]
fn refuses_outside_git_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let not_repo = tmp.path().join("plain");
    let grok_home = tmp.path().join("home");
    std::fs::create_dir_all(&not_repo).unwrap();
    std::fs::create_dir_all(&grok_home).unwrap();
    let ctx = InitContext {
        cwd: not_repo,
        grok_home,
        entries: load_golden_entries(),
        stdin_is_terminal: false,
    };
    let mut out = Vec::new();
    let err = init_cmd::run_with_context(&default_args(), &ctx, &mut out).unwrap_err();
    assert!(
        err.to_string().contains("git repository"),
        "unexpected error: {err:#}"
    );
}

#[test]
fn force_without_yes_on_non_tty_refuses() {
    let h = Harness::new();
    h.run(default_args());
    h.write_user("AGENTS.md", "# USER\n");
    let err = h.run_expect_err(InitArgs {
        force: true,
        yes: false,
        ..InitArgs::default()
    });
    assert!(
        err.contains("--yes") || err.contains("non-interactive"),
        "unexpected: {err}"
    );
    assert_eq!(h.read("AGENTS.md"), "# USER\n");
}
