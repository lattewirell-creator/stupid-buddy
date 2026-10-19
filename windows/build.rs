// Windows: the app icon and version details in the program file.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icon.ico").set("ProductName", "The Stupid Buddy").set("FileDescription", "The Stupid Buddy").set("LegalCopyright", "lattewirell-creator");
        res.compile().expect("Windows resources");
    }
    println!("cargo:rerun-if-changed=icon.ico");
    println!("cargo:rerun-if-changed=../ui");
}
