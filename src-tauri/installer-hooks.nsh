; NSIS 安装钩子：装之前先把残留进程清干净。
;
; 要解决的就是那个「Aihub 无法关闭。请手动关闭它，然后单击重试以继续。」对话框。
; 应用侧（update_install）已经会先自己拆干净再交给安装器，但有两种情况它兜不住：
;   1. 用户直接双击 setup.exe 覆盖安装，应用还开着
;   2. 应用崩了，留下孤儿 msedgewebview2.exe
; 所以安装器这边再兜一次底：静默杀掉，不问用户。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在关闭正在运行的 Aihub…"
  ; /T 连子进程一起收：每个站点的 WebView2 都是 aihub.exe 的子进程
  nsExec::Exec 'taskkill /F /T /IM aihub.exe'
  Pop $0
  ; 孤儿 WebView2（父进程已经没了的那些）单独再收一遍
  nsExec::Exec 'taskkill /F /IM msedgewebview2.exe /FI "WINDOWTITLE eq Aihub*"'
  Pop $0
  ; 给文件句柄一点释放时间，否则紧接着的写入仍可能撞上占用
  Sleep 1200
!macroend
