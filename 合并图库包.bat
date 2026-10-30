@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "Procreate内置笔尖图库_原图.zip.part1" (
  echo 找不到分卷文件，请把三个 part 文件和本脚本放在同一个文件夹。
  pause
  exit /b 1
)
if exist "Procreate内置笔尖图库_原图.zip" (
  echo 目标文件已存在，先改名再试：Procreate内置笔尖图库_原图.zip
  pause
  exit /b 1
)
copy /b "Procreate内置笔尖图库_原图.zip.part1"+"Procreate内置笔尖图库_原图.zip.part2"+"Procreate内置笔尖图库_原图.zip.part3" "Procreate内置笔尖图库_原图.zip" >nul
if errorlevel 1 (
  echo 合并失败。
  pause
  exit /b 1
)
echo 合并完成：Procreate内置笔尖图库_原图.zip
certutil -hashfile "Procreate内置笔尖图库_原图.zip" SHA256
pause
