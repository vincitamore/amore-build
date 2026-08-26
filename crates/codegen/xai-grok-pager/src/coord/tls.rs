//! House-issued TLS for the tailnet coord listener.
//!
//! Leaf is self-signed (rcgen). The keypair is generated once and stored
//! under `coord_root()/tls/` (`cert.der`, `key.der`) at mode 0600 (unix);
//! later listens reload it. The client pins the certificate fingerprint
//! per Tailscale node on first connect (TOFU). A later mismatch hard-fails
//! (no silent re-pin) and names the pin path. The client is authenticated
//! by the per-house shared secret (`house_token`, first application line)
//! and by a source-IP allowlist (this node's tailscale IPv4, or an IP that
//! resolves to a name in the seats file). No mTLS, no Tailscale Serve, no
//! Tailscale-issued certs.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme};

pub const COORD_PORT: u16 = 3856;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(5);

pub fn pin_dir() -> PathBuf {
    super::coord_root().join("tls").join("known")
}

pub fn pin_path_for(seat: &str) -> PathBuf {
    pin_dir().join(format!("{}.pin", super::safe_ident(seat)))
}

/// `~/.house/coord/tls/token` — per-house shared secret for tailnet lines.
pub fn token_path() -> PathBuf {
    super::coord_root().join("tls").join("token")
}

/// `~/.house/coord/tls/cert.der` — persisted leaf certificate.
pub fn cert_path() -> PathBuf {
    super::coord_root().join("tls").join("cert.der")
}

/// `~/.house/coord/tls/key.der` — persisted leaf PKCS#8 private key.
pub fn key_path() -> PathBuf {
    super::coord_root().join("tls").join("key.der")
}

/// Load the house token, generating and persisting one if missing.
///
/// File mode is 0600 on unix. Windows inherits the creating user's ACL.
pub fn house_token() -> Result<String, String> {
    let path = token_path();
    if let Some(t) = read_token(&path) {
        return Ok(t);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(format!("{token}\n").as_bytes())
                .map_err(|e| e.to_string())?;
            f.flush().map_err(|e| e.to_string())?;
            set_owner_readwrite(&path);
            Ok(token)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            read_token(&path).ok_or_else(|| "house token unreadable".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn read_token(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn set_owner_readwrite(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

pub fn fingerprint(der: &[u8]) -> String {
    blake3::hash(der).to_hex().to_string()
}

pub struct ServerTls {
    pub acceptor: tokio_rustls::TlsAcceptor,
}

pub fn server_config(ip: std::net::IpAddr, seat: &str) -> Result<ServerTls, String> {
    let (cert_der, key_der) = load_or_create_leaf(ip, seat)?;
    let cfg = rustls::ServerConfig::builder_with_provider(
        rustls::crypto::aws_lc_rs::default_provider().into(),
    )
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    // Client certs are not used. The tailnet client proves itself with the
    // house token on the first application line; socket.rs also admits only
    // this node's tailscale IPv4 or a seats-file name. The TOFU pin is
    // server-to-client only.
    .with_no_client_auth()
    .with_single_cert(vec![cert_der], key_der.into())
    .map_err(|e| {
        format!(
            "coord tls: leaf at {} / {} rejected: {e}",
            cert_path().display(),
            key_path().display()
        )
    })?;
    Ok(ServerTls {
        acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(cfg)),
    })
}

fn load_or_create_leaf(
    ip: std::net::IpAddr,
    seat: &str,
) -> Result<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>), String> {
    if let Some(pair) = load_leaf()? {
        return Ok(pair);
    }
    let (cert, key) = generate_leaf(ip, seat)?;
    persist_leaf(&cert, &key)?;
    load_leaf()?.ok_or_else(|| {
        format!(
            "coord tls: leaf unreadable after persist ({} / {})",
            cert_path().display(),
            key_path().display()
        )
    })
}

fn load_leaf() -> Result<Option<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>)>, String> {
    let cert_path = cert_path();
    let key_path = key_path();
    for attempt in 0..10 {
        let has_cert = cert_path.exists();
        let has_key = key_path.exists();
        match (has_cert, has_key) {
            (false, false) => return Ok(None),
            (true, true) => {
                let cert = fs::read(&cert_path)
                    .map_err(|e| format!("coord tls: read {}: {e}", cert_path.display()))?;
                let key = fs::read(&key_path)
                    .map_err(|e| format!("coord tls: read {}: {e}", key_path.display()))?;
                if cert.is_empty() || key.is_empty() {
                    return Err(format!(
                        "coord tls: empty leaf at {} / {}",
                        cert_path.display(),
                        key_path.display()
                    ));
                }
                return Ok(Some((
                    CertificateDer::from(cert),
                    PrivatePkcs8KeyDer::from(key),
                )));
            }
            _ if attempt + 1 < 10 => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                return Err(format!(
                    "coord tls: incomplete leaf (cert exists={has_cert} at {}, key exists={has_key} at {}) — delete leftover files to re-issue (peers must re-pin)",
                    cert_path.display(),
                    key_path.display()
                ));
            }
        }
    }
    Ok(None)
}

fn persist_leaf(cert: &[u8], key: &[u8]) -> Result<(), String> {
    let cert_path = cert_path();
    let key_path = key_path();
    if let Some(parent) = key_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&key_path)
    {
        Ok(mut f) => {
            f.write_all(key).map_err(|e| e.to_string())?;
            f.flush().map_err(|e| e.to_string())?;
            set_owner_readwrite(&key_path);
            if let Err(e) = fs::write(&cert_path, cert) {
                let _ = fs::remove_file(&key_path);
                return Err(e.to_string());
            }
            set_owner_readwrite(&cert_path);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn generate_leaf(ip: std::net::IpAddr, seat: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let mut params =
        rcgen::CertificateParams::new(vec![seat.to_string()]).map_err(|e| e.to_string())?;
    params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    Ok((cert.der().to_vec(), key.serialize_der()))
}

#[derive(Debug)]
struct TofuVerifier {
    seat: String,
    provider: rustls::crypto::CryptoProvider,
}

/// TOFU: first seen fingerprint is written; later mismatch is a hard fail.
fn pin_or_verify(seat: &str, fp: &str) -> Result<(), String> {
    let path = pin_path_for(seat);
    if path.exists() {
        return verify_existing_pin(seat, fp, &path);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(fp.as_bytes()).map_err(|e| e.to_string())?;
            f.flush().map_err(|e| e.to_string())?;
            set_owner_readwrite(&path);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            verify_existing_pin(seat, fp, &path)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn verify_existing_pin(seat: &str, fp: &str, path: &Path) -> Result<(), String> {
    let known = fs::read_to_string(path).map_err(|e| {
        format!(
            "coord tls pin unreadable for seat {seat} (pin {}): {e}",
            path.display()
        )
    })?;
    let pinned = known.trim();
    if pinned == fp {
        Ok(())
    } else {
        Err(format!(
            "coord tls pin mismatch for seat {seat}: presented {fp} != pinned {pinned} (pin {})",
            path.display()
        ))
    }
}

impl ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let fp = fingerprint(end_entity.as_ref());
        pin_or_verify(&self.seat, &fp).map_err(TlsError::General)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub fn tls_post(hostport: &str, seat: &str, payload: &str) -> Result<String, String> {
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    let verifier = Arc::new(TofuVerifier {
        seat: seat.to_string(),
        provider: provider.clone(),
    });
    let cfg = ClientConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let name: ServerName<'static> = ServerName::try_from(seat.to_string())
        .or_else(|_| ServerName::try_from("coord".to_string()))
        .map_err(|e| e.to_string())?;
    let conn = rustls::ClientConnection::new(Arc::new(cfg), name).map_err(|e| e.to_string())?;
    let addr = resolve_hostport(hostport)?;
    let sock = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(s) => s,
        Err(e) => return Err(map_timeout(e, "connect", hostport, CONNECT_TIMEOUT)),
    };
    sock.set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    sock.set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut tls = rustls::StreamOwned::new(conn, sock);
    tls.write_all(payload.as_bytes())
        .map_err(|e| map_timeout(e, "write", hostport, IO_TIMEOUT))?;
    let _ = tls.flush();
    let mut line = String::new();
    BufReader::new(&mut tls)
        .read_line(&mut line)
        .map_err(|e| map_timeout(e, "read", hostport, IO_TIMEOUT))?;
    Ok(line)
}

fn resolve_hostport(hostport: &str) -> Result<std::net::SocketAddr, String> {
    match hostport.parse() {
        Ok(addr) => Ok(addr),
        Err(_) => hostport
            .to_socket_addrs()
            .map_err(|e| format!("coord tls: resolve {hostport}: {e}"))?
            .next()
            .ok_or_else(|| format!("coord tls: no address for {hostport}")),
    }
}

fn map_timeout(err: std::io::Error, op: &str, hostport: &str, budget: Duration) -> String {
    if err.kind() == ErrorKind::TimedOut || err.kind() == ErrorKind::WouldBlock {
        format!(
            "coord tls: {op} timed out after {}s to {hostport}",
            budget.as_secs()
        )
    } else {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::path::Path;
    use std::time::Instant;

    struct EnvRestore {
        coord: Option<std::ffi::OsString>,
        root: PathBuf,
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.coord {
                Some(v) => unsafe { std::env::set_var("HOUSE_COORD_DIR", v) },
                None => unsafe { std::env::remove_var("HOUSE_COORD_DIR") },
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn with_isolated_coord<R>(f: impl FnOnce(&Path) -> R) -> R {
        let _g = crate::coord::COORD_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!(
            "amore-tls-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let presence = root.join("presence");
        fs::create_dir_all(&presence).unwrap();
        let restore = EnvRestore {
            coord: std::env::var_os("HOUSE_COORD_DIR"),
            root: root.clone(),
        };
        unsafe { std::env::set_var("HOUSE_COORD_DIR", &presence) };
        let result = f(&root);
        drop(restore);
        result
    }

    #[test]
    fn fingerprint_is_stable() {
        let a = fingerprint(b"abc");
        let b = fingerprint(b"abc");
        assert_eq!(a, b);
        assert_ne!(a, fingerprint(b"abd"));
    }

    #[test]
    fn house_token_creates_and_reloads() {
        with_isolated_coord(|root| {
            let a = house_token().expect("create house token");
            assert!(!a.is_empty());
            let path = root.join("tls").join("token");
            assert_eq!(path, token_path());
            assert_eq!(fs::read_to_string(&path).unwrap().trim(), a);
            let b = house_token().expect("reload house token");
            assert_eq!(a, b);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
        });
    }

    #[test]
    fn house_token_keeps_existing_file() {
        with_isolated_coord(|root| {
            let dir = root.join("tls");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("token"), "already-shared-secret\n").unwrap();
            assert_eq!(house_token().unwrap(), "already-shared-secret");
        });
    }

    #[test]
    fn server_config_persists_leaf_and_reloads() {
        with_isolated_coord(|root| {
            let ip_a: IpAddr = "100.64.0.1".parse().unwrap();
            let ip_b: IpAddr = "100.64.0.2".parse().unwrap();
            server_config(ip_a, "node-one").expect("first listen");
            let cert = root.join("tls").join("cert.der");
            let key = root.join("tls").join("key.der");
            assert_eq!(cert, cert_path());
            assert_eq!(key, key_path());
            assert!(cert.exists());
            assert!(key.exists());
            let cert_bytes = fs::read(&cert).unwrap();
            let key_bytes = fs::read(&key).unwrap();
            assert!(!cert_bytes.is_empty());
            assert!(!key_bytes.is_empty());
            let fp = fingerprint(&cert_bytes);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let cert_mode = fs::metadata(&cert).unwrap().permissions().mode() & 0o777;
                let key_mode = fs::metadata(&key).unwrap().permissions().mode() & 0o777;
                assert_eq!(cert_mode, 0o600);
                assert_eq!(key_mode, 0o600);
            }
            server_config(ip_b, "node-two").expect("reload listen");
            assert_eq!(fs::read(&cert).unwrap(), cert_bytes);
            assert_eq!(fs::read(&key).unwrap(), key_bytes);
            assert_eq!(fingerprint(&fs::read(&cert).unwrap()), fp);
        });
    }

    #[test]
    fn pin_first_seen_then_hard_fail_names_path() {
        with_isolated_coord(|root| {
            let seat = "peer-one";
            let path = pin_path_for(seat);
            assert_eq!(path, root.join("tls").join("known").join("peer-one.pin"));
            let a = fingerprint(b"leaf-a");
            let b = fingerprint(b"leaf-b");
            pin_or_verify(seat, &a).expect("first pin");
            assert_eq!(fs::read_to_string(&path).unwrap(), a);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
            pin_or_verify(seat, &a).expect("same fingerprint");
            let err = pin_or_verify(seat, &b).expect_err("mismatch must hard-fail");
            assert!(err.contains("pin mismatch"), "reason missing from {err}");
            assert!(
                err.contains(&path.display().to_string()),
                "pin path missing from {err}"
            );
            assert!(err.contains(&a), "pinned fingerprint missing from {err}");
            assert!(err.contains(&b), "presented fingerprint missing from {err}");
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                a,
                "mismatch must not re-pin"
            );
        });
    }

    #[test]
    fn pin_corrupt_existing_does_not_rewrite() {
        with_isolated_coord(|_root| {
            let seat = "peer-two";
            let path = pin_path_for(seat);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "not-a-real-fingerprint").unwrap();
            let presented = fingerprint(b"leaf-c");
            let err = pin_or_verify(seat, &presented).expect_err("corrupt pin hard-fails");
            assert!(err.contains("pin mismatch"), "{err}");
            assert!(err.contains(&path.display().to_string()), "{err}");
            assert_eq!(fs::read_to_string(&path).unwrap(), "not-a-real-fingerprint");
        });
    }

    #[test]
    fn tls_post_connect_timeout_does_not_hang() {
        with_isolated_coord(|_root| {
            let start = Instant::now();
            let err = tls_post("192.0.2.1:3856", "peer-one", "x")
                .expect_err("TEST-NET-1 must not succeed");
            let elapsed = start.elapsed();
            assert!(
                elapsed < CONNECT_TIMEOUT + Duration::from_secs(3),
                "connect hung: {elapsed:?} err={err}"
            );
            assert!(
                err.contains("timed out") || err.contains("timed") || !err.is_empty(),
                "empty connect error"
            );
        });
    }

    #[test]
    fn verifier_mismatch_error_includes_pin_path() {
        with_isolated_coord(|_root| {
            let seat = "peer-one";
            let provider = rustls::crypto::aws_lc_rs::default_provider();
            let v = TofuVerifier {
                seat: seat.to_string(),
                provider,
            };
            let name = ServerName::try_from(seat.to_string()).unwrap();
            let now = UnixTime::now();
            let first = CertificateDer::from(b"leaf-a".to_vec());
            v.verify_server_cert(&first, &[], &name, &[], now)
                .expect("first pin via verifier");
            let second = CertificateDer::from(b"leaf-b".to_vec());
            let err = v
                .verify_server_cert(&second, &[], &name, &[], now)
                .expect_err("verifier hard-fail");
            let msg = err.to_string();
            let path = pin_path_for(seat);
            assert!(msg.contains("pin mismatch"), "{msg}");
            assert!(msg.contains(&path.display().to_string()), "{msg}");
        });
    }
}
