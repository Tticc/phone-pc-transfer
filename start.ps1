# 自动检测当前活动局域网 IP 并启动/更新容器
$activeIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -notmatch "vEthernet|Loopback|Meta" -and
    $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
} | Select-Object -First 1).IPAddress

if (-not $activeIp) {
    Write-Error "未检测到有效的局域网 IPv4 地址，请确保已连接 Wi-Fi。"
    exit 1
}

$publicUrl = "http://${activeIp}:9100"
Write-Host "检测到本机当前局域网 IP: $activeIp" -ForegroundColor Green
Write-Host "手机访问地址将设置为: $publicUrl" -ForegroundColor Green

# 停止并移除已有容器以更新 PUBLIC_URL
wslc stop ptc 2>$null
wslc rm ptc 2>$null
wslc stop phone-pc-transfer 2>$null
wslc rm phone-pc-transfer 2>$null

wslc run -d --name ptc -p 0.0.0.0:9100:9100 `
    -e PORT=9100 -e PUBLIC_URL=$publicUrl -e DATA_DIR=/data `
    -e MAX_SESSIONS=10 -e RECEIVER_GRACE_MS=120000 `
    --tmpfs /data:size=512m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev `
    --tmpfs /tmp:size=16m,mode=1777,noexec,nosuid,nodev `
    -m 768m ptc:1.1.0

Write-Host "服务已就绪！电脑浏览器请打开: http://localhost:9100" -ForegroundColor Cyan
