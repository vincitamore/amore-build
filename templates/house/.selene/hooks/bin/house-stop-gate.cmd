@echo off
rem house stop gate shim — spawned directly by the hook runner (no shell
rem metachars in its path, so CreateProcess routes this .cmd via cmd /c; Rust's
rem post-CVE-2024-24576 spawn handles batch files safely).
python "%~dp0house_stop_gate.py" %*
