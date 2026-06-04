use assert_cmd::Command;
use predicates::prelude::*;

fn gerber_fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/gerber/plaid")
}

#[test]
fn info_on_gerber_dir_lists_layers() {
    Command::cargo_bin("cuprum")
        .unwrap()
        .args(["info", gerber_fixture().to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("layers ("));
}

#[test]
fn info_json_is_parseable() {
    let out = Command::cargo_bin("cuprum")
        .unwrap()
        .args(["--json", "info", gerber_fixture().to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert!(v["layers"].is_array());
}

#[test]
fn missing_input_errors_with_code_1() {
    Command::cargo_bin("cuprum")
        .unwrap()
        .args(["info", "/no/such/path"])
        .assert()
        .code(1);
}

#[test]
fn render_writes_a_png() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.png");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "render",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']), "PNG magic");
}

#[test]
fn svg_writes_an_svg() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.svg");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "svg",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();
    let s = std::fs::read_to_string(&out).unwrap();
    assert!(s.contains("<svg"), "is an SVG document");
}

#[test]
fn mesh_glb_default() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.glb");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "3d",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();
    assert_eq!(&std::fs::read(&out).unwrap()[0..4], b"glTF");
}

#[test]
fn mesh_stl_format_flag() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.stl");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "3d",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
            "--format",
            "stl",
        ])
        .assert()
        .success();
    assert!(std::fs::read(&out).unwrap().len() > 84);
}

#[test]
fn mesh_obj_writes_obj_and_mtl() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.obj");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "3d",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
            "--format",
            "obj",
        ])
        .assert()
        .success();
    assert!(out.exists() && out.with_extension("mtl").exists());
}

#[test]
fn check_json_has_metrics_and_gate() {
    let out = Command::cargo_bin("cuprum")
        .unwrap()
        .args(["--json", "check", gerber_fixture().to_str().unwrap()])
        .assert()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert!(v["metrics"].is_object());
    // Severity serializes lowercase ("ok"/"block"), consistent with the rest of the API.
    assert!(matches!(
        v["gate"]["worst"].as_str(),
        Some("ok") | Some("block")
    ));
}

#[test]
fn check_gate_fails_with_strict_profile() {
    let dir = tempfile::tempdir().unwrap();
    let prof = dir.path().join("p.json");
    std::fs::write(
        &prof,
        r#"{"minTraceMm":99.0,"minClearanceMm":99.0,"minDrillMm":99.0,"minAnnularMm":99.0}"#,
    )
    .unwrap();
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "check",
            gerber_fixture().to_str().unwrap(),
            "--profile",
            prof.to_str().unwrap(),
        ])
        .assert()
        .code(2);
}
