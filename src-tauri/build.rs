fn main() {
    // 前端是**编译期**嵌进二进制里的（tauri.conf.json 的 frontendDist = ../src-ui，
    // 由 tauri::generate_context! 读进来）。tauri-build 只为 tauri.conf.json 和
    // capabilities 声明 rerun-if-changed，**不管 src-ui**——于是只改 src-ui/index.html
    // 时 cargo 认为无事发生，跑出来的还是旧界面。踩过一次，所以在这里补上。
    println!("cargo:rerun-if-changed=../src-ui");
    tauri_build::build()
}
