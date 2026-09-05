# 바탕화면에 "한모아" 바로가기를 만든다.
#
# start.bat 이 실행될 때마다 이 스크립트를 부른다. 두 번째부터는 아무 일도
# 하지 않아야 하므로, 한 번 만들고 나면 마커 파일을 남겨 그 사실을 기억한다.
# 사용자가 바로가기를 지웠어도 다시 만들지 않는다 — 지운 것은 사용자의 선택이다.
#
# 이 스크립트가 실패해도 start.bat 은 계속 진행되어야 한다. 바로가기는 있으면
# 편한 것이지 없다고 앱을 못 쓰는 것은 아니기 때문이다. 그래서 오류를 밖으로
# 던지지 않고 조용히 넘어간다.

param(
    [Parameter(Mandatory = $true)]
    [string]$BaseDir
)

$ErrorActionPreference = 'SilentlyContinue'

$marker = Join-Path $BaseDir '.shortcut_made'
if (Test-Path $marker) {
    exit 0
}

try {
    # OneDrive로 바탕화면이 옮겨진 PC(학교에서 흔하다)도 정확히 찾는다.
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop '한모아.lnk'
    $startBat = Join-Path $BaseDir 'start.bat'
    $icon = Join-Path $BaseDir 'assets\icon.ico'

    if (Test-Path $startBat) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $startBat
        $shortcut.WorkingDirectory = $BaseDir
        if (Test-Path $icon) {
            $shortcut.IconLocation = "$icon,0"
        }
        $shortcut.Description = '한모아 - 한글 병합되는 무료 PDF 도구'
        $shortcut.Save()
    }
} catch {
    # 실패해도 조용히 넘어간다. start.bat 의 실행을 막을 이유가 아니다.
}

# 성공하든 실패하든 마커는 남긴다. 실패할 때마다 매번 재시도하면
# 느린 PC에서 실행할 때마다 시간을 더 잡아먹는다.
New-Item -ItemType File -Path $marker -Force | Out-Null
