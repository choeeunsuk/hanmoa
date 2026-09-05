# 이 PC 에서 쓸 수 있는 python.exe 를 찾아 그 경로 한 줄만 찍는다.
# 못 찾으면 아무것도 찍지 않는다.
#
# 왜 PATH 만 믿으면 안 되는가:
#
# PATH 는 생각보다 자주 망가진다. 실제로 이 프로젝트를 만들며 만난 PC 에서는
# 사용자 PATH 에 적힌 경로들이 한글 사용자명 부분만 깨져 있었다. 어떤 설치
# 프로그램이 인코딩을 잘못 써 넣은 탓이다. 그 결과 탐색기에서 띄운 창은
# python 도 py 도 찾지 못했다. 명령 프롬프트에서는 되는데 바로가기로는 안 되는,
# 사용자로서는 도무지 알 수 없는 증상이 이렇게 생긴다.
#
# 그래서 PATH 말고도 여러 곳을 본다. 레지스트리에 적힌 설치 정보가 가장
# 믿을 만하고, 그 다음이 사람들이 흔히 설치하는 폴더들이다.
#
# 찾기만 하고 끝내지 않는다. 후보마다 실제로 실행해 보고 대답하는 것만 고른다.
# Windows 에는 진짜 python 이 없어도 python.exe 라는 이름의 껍데기가 있어서,
# 존재 여부만으로는 판단할 수 없기 때문이다.

$ErrorActionPreference = 'SilentlyContinue'

function Test-RealPython {
    param([string]$Exe)
    if (-not $Exe) { return $false }
    if (-not (Test-Path $Exe)) { return $false }
    # Microsoft Store 껍데기는 이 호출에서 0 이 아닌 값을 돌려준다.
    & $Exe -c "import sys" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

$candidates = New-Object System.Collections.Generic.List[string]

# 1) PATH. 멀쩡한 PC 에서는 여기서 끝난다.
foreach ($name in @('python.exe', 'py.exe')) {
    Get-Command $name -All | ForEach-Object { $candidates.Add($_.Source) }
}

# 2) 레지스트리. 설치 프로그램이 남긴 기록이라 PATH 보다 믿을 만하다.
foreach ($hive in @('HKCU:\Software\Python\PythonCore',
                    'HKLM:\Software\Python\PythonCore',
                    'HKLM:\Software\WOW6432Node\Python\PythonCore')) {
    Get-ChildItem $hive | ForEach-Object {
        $props = Get-ItemProperty (Join-Path $_.PSPath 'InstallPath')
        if ($props.ExecutablePath) {
            $candidates.Add($props.ExecutablePath)
        } elseif ($props.'(default)') {
            $candidates.Add((Join-Path $props.'(default)' 'python.exe'))
        }
    }
}

# 3) 사람들이 흔히 설치하는 폴더들.
#    pythoncore-* 는 파이썬 3.14 부터 쓰는 새 설치 관리자의 폴더 이름이다.
$roots = @(
    "$env:LOCALAPPDATA\Programs\Python",
    "$env:LOCALAPPDATA\Python",
    "$env:ProgramFiles",
    "${env:ProgramFiles(x86)}",
    'C:\'
)
foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -Directory |
        Where-Object { $_.Name -match '^(Python|pythoncore)' } |
        ForEach-Object { $candidates.Add((Join-Path $_.FullName 'python.exe')) }
}

# 4) py 런처가 있으면 그것도 후보로 둔다. 여러 판이 깔린 PC 에서 알아서 고른다.
$candidates.Add("$env:LOCALAPPDATA\Programs\Python\Launcher\py.exe")
$candidates.Add("$env:WINDIR\py.exe")

# 어느 것을 고를 것인가.
#
# 여러 파이썬이 깔린 PC 가 흔하다. 이 PC 만 해도 Spyder 가 끼워 넣은 것과
# 사용자가 직접 설치한 것 두 개가 있었다. 아무거나 고르면 한모아 구성요소를
# 처음부터 다시 설치하게 되고, 그 파이썬이 잠겨 있으면 설치조차 실패한다.
#
# 그래서 이미 한모아를 돌릴 준비가 된 것을 가장 먼저 친다. 점수를 매겨 고른다.
$needed = 'fastapi', 'uvicorn', 'pypdf', 'pymupdf'

function Get-Score {
    param([string]$Exe)
    $score = 0

    # 한모아 구성요소가 이미 깔려 있으면 압도적으로 우선한다. 그대로 쓰면 되니까.
    $probe = 'import ' + ($needed -join ', ')
    & $Exe -c $probe 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $score += 1000 }

    # 표준 설치 위치를 그 다음으로 친다. 다른 프로그램이 끼워 넣은 파이썬은
    # 나중에 그 프로그램을 지우면 함께 사라져 한모아가 갑자기 안 되게 된다.
    if ($Exe -like '*Programs\Python\Python*' -or $Exe -like '*pythoncore-*') { $score += 100 }
    if ($Exe -like '*\Python3*') { $score += 50 }

    # 스토어 껍데기 자리는 피한다.
    if ($Exe -like '*WindowsApps*') { $score -= 500 }

    # 같은 조건이면 새 판을 쓴다.
    if ($Exe -match 'ython.?(3)(1[0-9])') { $score += [int]$Matches[2] }

    return $score
}

$best = $null
$bestScore = [int]::MinValue
$seen = @{}
foreach ($exe in $candidates) {
    if (-not $exe) { continue }
    if ($seen.ContainsKey($exe)) { continue }
    $seen[$exe] = $true
    if (-not (Test-RealPython $exe)) { continue }
    $score = Get-Score $exe
    if ($score -gt $bestScore) {
        $bestScore = $score
        $best = $exe
    }
}

if ($best) {
    Write-Output $best
    exit 0
}
exit 1
