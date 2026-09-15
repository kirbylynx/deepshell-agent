fn main() {
    println!("cargo:rerun-if-env-changed=DEEPSHELL_SOURCE_INPUT_SHA256");
    let source_input =
        std::env::var("DEEPSHELL_SOURCE_INPUT_SHA256").unwrap_or_else(|_| "unbound".to_string());
    println!("cargo:rustc-env=DEEPSHELL_SOURCE_INPUT_SHA256={source_input}");
    tauri_build::build()
}
