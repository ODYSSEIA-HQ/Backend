# ODYSSEIA 业务链路冒烟测试（压测床布局，https://localhost）
# 链路：登录 → 建号 → 发帖 → Meili 索引 → 搜索 hook → slowmode 拦截 →
#       topic delete(索引批删) → restore(回索引) → Centrifugo publish 凭证
# 压测床 = docker compose up（不带 dev 叠加层）：caddy 80/443 + mongo 自带认证。
# 早期 dev 栈（localhost:8080 + mongo 免认证）的写法已随布局演进作废。
$ErrorActionPreference = 'Continue'
$base = 'https://localhost'
# PS5.1 信任 caddy 内部自签证书（pwsh 的 -SkipCertificateCheck 在 5.1 不可用）
if (-not ([System.Management.Automation.PSTypeName]'SmokeTrustAll').Type) {
    Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class SmokeTrustAll : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::CertificatePolicy = New-Object SmokeTrustAll
# mongosh 认证参数：compose 主层 MONGO_INITDB_* 使 mongo 带 root 认证，
# 凭证从 ../.env 运行时读取（.env 不入库，脚本也不落秘密）
# 必须用 ReadAllText（.NET 默认 UTF-8）：PS5.1 的 Get-Content -Raw 按 ANSI/GBK 解码
# 无 BOM 文件，中文注释的 UTF-8 字节流会把 USERNAME 行前的 \n 吞进乱码替换符，
# 导致 (?m)^ 锚失效、用户名解析为空。
$envRaw = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\.env'))
$mongoUser = [regex]::Match($envRaw, '(?m)^MONGO_INITDB_ROOT_USERNAME=(.+)$').Groups[1].Value.Trim()
$mongoPass = [regex]::Match($envRaw, '(?m)^MONGO_INITDB_ROOT_PASSWORD=(.+)$').Groups[1].Value.Trim()
$mongoAuth = @('-u', $mongoUser, '-p', $mongoPass, '--authenticationDatabase', 'admin')
$adminName = [regex]::Match($envRaw, '(?m)^NODEBB_ADMIN_USERNAME=(.+)$').Groups[1].Value.Trim().Trim('"').Trim("'")
if (-not $adminName) { $adminName = 'admin' }
$adminPass = [regex]::Match($envRaw, '(?m)^NODEBB_ADMIN_PASSWORD=(.+)$').Groups[1].Value.Trim().Trim('"').Trim("'")
if (-not $adminPass) { throw 'NODEBB_ADMIN_PASSWORD is required in .env' }
$PASS = 0; $FAIL = 0
function Mark($ok, $name, $detail) {
    if ($ok) { $script:PASS++; Write-Host "PASS  $name  $detail" }
    else { $script:FAIL++; Write-Host "FAIL  $name  $detail" }
}
# Meili 容器内查询 helper（宿主机够不到 data/app 内网；GET 覆盖 stats/search/settings，
# 规避 PS5.1 向原生命令传参时嵌套双引号被吞的坑）
function Meili($path) {
    $out = docker exec odysseia-nodebb-1 node -e "const k=process.env.MEILI_MASTER_KEY;fetch('http://meilisearch:7700$path',{headers:{'Authorization':'Bearer '+k}}).then(async r=>{console.error('HTTP '+r.status);console.log(await r.text())}).catch(e=>{console.error('ERR '+e.message);console.log('{}')})" 2>&1
    $httpLine = ($out | Select-String -Pattern 'HTTP \d+' | Select-Object -First 1)
    $json = ($out | Where-Object { $_ -notmatch '^HTTP|^ERR' }) -join ''
    $status = 0
    if ($httpLine -match 'HTTP (\d+)') { $status = [int]$Matches[1] }
    return @{ status = $status; body = $json }
}

Write-Host '=== [1] admin 登录 ==='
$cfg = Invoke-RestMethod -Uri "$base/api/config" -SessionVariable adm
$adminLoginBody = @{ username = $adminName; password = $adminPass } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri "$base/api/v3/utilities/login" -Method Post -WebSession $adm -Headers @{ 'X-CSRF-Token' = $cfg.csrf_token } -ContentType 'application/json' -Body $adminLoginBody
Mark ($login.status.code -eq 'ok') 'admin-login' "code=$($login.status.code)"

Write-Host '=== [1b] 关闭 post-queue ==='
# NodeBB 默认 postQueue=1（install/data/defaults.json:29）：新号 postcount=0 或声誉<1 的帖全部
# 入队走 202 {queued:true}，无 response.tid。冒烟验证的是直发链路，先关掉（走 ACP write API，
# meta.configs.set 会刷新内存缓存；mongosh 直改 config 集合不触发同步，不能用）
try {
    Invoke-RestMethod -Uri "$base/api/v3/admin/settings/postQueue" -Method Put -WebSession $adm -Headers @{ 'X-CSRF-Token' = $cfg.csrf_token } -ContentType 'application/json' -Body '{"value":0}' | Out-Null
    Mark $true 'postqueue-off' 'meta.config.postQueue=0'
} catch {
    Mark $false 'postqueue-off' $_.Exception.Message
}

Write-Host '=== [2] admin 创建/复用用户 alice（幂等）==='
# NodeBB 对重名不报错而是静默改名（'alice' 已存在时新建得到 'alice 0'），
# 所以必须先查 username:uid sorted set（value=用户名, score=uid）再决定建不建
$aliceUid = docker exec odysseia-mongo-1 mongosh --quiet $mongoAuth odysseia --eval "print(db.objects.findOne({_key:'username:uid',value:'alice'})?.score ?? '')" | Select-String -Pattern '^\d+$' | Select-Object -First 1
# 顺带清理早前误建的 'alice 0'（走 admin purge API 干净移除全部关联键；无则跳过）
$staleUid = docker exec odysseia-mongo-1 mongosh --quiet $mongoAuth odysseia --eval "print(db.objects.findOne({_key:'username:uid',value:'alice 0'})?.score ?? '')" | Select-String -Pattern '^\d+$' | Select-Object -First 1
if ($staleUid) {
    Invoke-RestMethod -Uri "$base/api/v3/users/$($staleUid.ToString())" -Method Delete -WebSession $adm -Headers @{ 'X-CSRF-Token' = $cfg.csrf_token } | Out-Null
    Mark $true 'cleanup-stale-user' "purged 'alice 0' uid=$($staleUid.ToString())"
}
if ($aliceUid) {
    $aliceUid = $aliceUid.ToString()
    Mark $true 'create-alice' "exists, uid=$aliceUid (rerun)"
} else {
    try {
        $u = Invoke-RestMethod -Uri "$base/api/v3/users" -Method Post -WebSession $adm -Headers @{ 'X-CSRF-Token' = $cfg.csrf_token } -ContentType 'application/json' -Body '{"username":"alice","password":"alice-pass-123","email":"alice@localhost"}'
        Mark ($u.status.code -eq 'ok') 'create-alice' "uid=$($u.response.uid)"
        $aliceUid = $u.response.uid
    } catch {
        Mark $false 'create-alice' $_.Exception.Message
    }
}

Write-Host '=== [3] 分类列表 ==='
$cats = Invoke-RestMethod -Uri "$base/api/v3/categories"
$cid = ($cats.response.categories | Where-Object { $_.cid -gt 1 } | Select-Object -First 1).cid
Mark ($cid -gt 0) 'categories' "cid=$cid"

Write-Host '=== [4] Meili posts 索引基线 ==='
$before = Meili '/indexes/posts/stats'
$beforeCount = 0
if ($before.status -eq 200 -and $before.body -match '"numberOfDocuments":(\d+)') { $beforeCount = [int]$Matches[1] }
# 404 = 索引未建（首装后从未发过帖），基线按 0 算，不算失败
Mark ($before.status -eq 200 -or $before.status -eq 404) 'meili-baseline' "docs=$beforeCount http=$($before.status)"

Write-Host '=== [5] alice 登录 + 发主题帖 ==='
$cfgA = Invoke-RestMethod -Uri "$base/api/config" -SessionVariable ali
$loginA = Invoke-RestMethod -Uri "$base/api/v3/utilities/login" -Method Post -WebSession $ali -Headers @{ 'X-CSRF-Token' = $cfgA.csrf_token } -ContentType 'application/json' -Body '{"username":"alice","password":"alice-pass-123"}'
Mark ($loginA.status.code -eq 'ok') 'alice-login' "code=$($loginA.status.code)"
# 声誉直改 user hash 立即生效（用户字段无内存缓存）：5 >= newbieReputationThreshold(3)，
# 让后续发帖只受 initialPostDelay（joindate 基准，绕不开）与通用 postDelay 约束
docker exec odysseia-mongo-1 mongosh --quiet $mongoAuth odysseia --eval "db.objects.updateOne({_key:'user:$aliceUid'},{`$set:{reputation:5}})" | Out-Null
# NodeBB 原生防垃圾：新号 joindate + initialPostDelay（默认 10s，src/user/posts.js:70）内禁止首帖
Start-Sleep -Seconds 11
$topic = Invoke-RestMethod -Uri "$base/api/v3/topics" -Method Post -WebSession $ali -Headers @{ 'X-CSRF-Token' = $cfgA.csrf_token } -ContentType 'application/json' -Body ('{"cid":' + $cid + ',"title":"Odysseia smoke marker zebra42","content":"hello meili indexing"}')
$tid = $topic.response.tid
Mark ($tid -gt 0) 'alice-post-topic' "tid=$tid"

Write-Host '=== [6] Meili 索引落地（action:post.save → bridge → meili）==='
Start-Sleep -Seconds 4
$after = Meili '/indexes/posts/stats'
$afterCount = if ($after.body -match '"numberOfDocuments":(\d+)') { [int]$Matches[1] } else { -1 }
Mark ($afterCount -gt $beforeCount) 'meili-index-grew' "docs $beforeCount -> $afterCount"
$hit = Meili '/indexes/posts/search?q=zebra42'
Mark ($hit.body -match 'zebra42') 'meili-search-hit' "found=$($hit.body -match 'zebra42')"
$fattr = Meili '/indexes/posts/settings/filterable-attributes'
Mark ($fattr.body -match 'cid') 'meili-filterable-cid' $fattr.body

Write-Host '=== [7] slowmode 拦截（filter:topic.post → 原子冷却键）==='
# alice 声誉已在步 5 boost 至 5 >= newbieReputationThreshold(3)，newbiePostDelay(120s) 不触发；
# 再睡过通用 postDelay(10s)，让唯一能拦帖的只剩分类 slowmode——排除假阳性后真验证冷却键。
# 两帖设计：checkSlowmode「通过即占位」（首次查询无冷却键 → 放行并落键），
# 故第一帖必成功、第二帖（60s 冷却窗内）必被拦——单帖探针会把"放行"误判成 FAIL
docker exec odysseia-mongo-1 mongosh --quiet $mongoAuth odysseia --eval "db.objects.updateOne({_key:'category:$cid'},{`$set:{slowmodeSeconds:60}})" | Out-Null
Start-Sleep -Seconds 11
$ok1 = $false
try {
    Invoke-RestMethod -Uri "$base/api/v3/topics" -Method Post -WebSession $ali -Headers @{ 'X-CSRF-Token' = $cfgA.csrf_token } -ContentType 'application/json' -Body ('{"cid":' + $cid + ',"title":"slowmode probe one","content":"probe1 0123456789"}') | Out-Null
    $ok1 = $true
} catch { $ok1 = $false }
Mark $ok1 'slowmode-first-post-passes' $(if ($ok1) { 'allowed, cooldown keyed' } else { 'first probe unexpectedly blocked' })
$blocked = $false
$blockErr = ''
try {
    Invoke-RestMethod -Uri "$base/api/v3/topics" -Method Post -WebSession $ali -Headers @{ 'X-CSRF-Token' = $cfgA.csrf_token } -ContentType 'application/json' -Body ('{"cid":' + $cid + ',"title":"should be blocked","content":"slowmode probe 0123456789"}') | Out-Null
} catch {
    $blocked = $true
    try {
        # PS5.1 Invoke-RestMethod 抛错前已消费响应流（SyncMemoryStream Position 停在末尾），
        # 必须 Position=0 重置再读，否则 ReadToEnd 拿到空串（SyncMemoryStream 无 DiscardBufferedData）
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream.CanSeek) { $stream.Position = 0 }
        $reader = New-Object System.IO.StreamReader($stream)
        $blockErr = $reader.ReadToEnd()
    } catch { $blockErr = $_.Exception.Message }
}
# 断言文案锚「过于频繁」：插件 slowmode 文案独有，与 NodeBB postDelay
# （en: "too many posts" / zh-CN: "发帖需要间隔"）不撞——拦了但文案不对也判 FAIL
Mark ($blocked -and $blockErr -match '过于频繁') 'slowmode-blocks-second-post' $(if ($blocked) { $blockErr } else { 'second post unexpectedly allowed' })
docker exec odysseia-mongo-1 mongosh --quiet $mongoAuth odysseia --eval "db.objects.updateOne({_key:'category:$cid'},{`$set:{slowmodeSeconds:0}})" | Out-Null

Write-Host '=== [8] topic delete → Meili 批删 + guest 视角 404 ==='
Start-Sleep -Seconds 3
# 删除前基线：步 7 探针帖（probe one）已入索引，不能用步 6 的 afterCount 当基线
$preDelCount = Meili '/indexes/posts/stats'
$preDelN = if ($preDelCount.body -match '"numberOfDocuments":(\d+)') { [int]$Matches[1] } else { -1 }
$del = Invoke-RestMethod -Uri "$base/api/v3/topics/$tid/state" -Method Delete -WebSession $adm -Headers @{ 'X-CSRF-Token' = $cfg.csrf_token }
Mark ($del.status.code -eq 'ok') 'topic-delete' "tid=$tid"
Start-Sleep -Seconds 4
$delCount = Meili '/indexes/posts/stats'
$delN = if ($delCount.body -match '"numberOfDocuments":(\d+)') { [int]$Matches[1] } else { -1 }
Mark ($delN -lt $preDelN) 'meili-purged-on-delete' "docs $preDelN -> $delN"
# guest 视角（无 session）：被删主题对未登录访客 404/403。不能用 alice——NodeBB 设计上
# 作者本人可见自己被删的主题，以作者断言会永远假阳性
$guestSees = $true
try { Invoke-RestMethod -Uri "$base/api/v3/topics/$tid" | Out-Null } catch { $guestSees = $false }
Mark (-not $guestSees) 'deleted-topic-hidden-from-guest' $(if ($guestSees) { 'STILL VISIBLE' } else { '404 as expected' })

Write-Host '=== [9] topic restore → 回索引 + alice 可见 ==='
$res = Invoke-RestMethod -Uri "$base/api/v3/topics/$tid/state" -Method Put -WebSession $adm -Headers @{ 'X-CSRF-Token' = $cfg.csrf_token }
Mark ($res.status.code -eq 'ok') 'topic-restore' ''
Start-Sleep -Seconds 4
$resCount = Meili '/indexes/posts/stats'
$resN = if ($resCount.body -match '"numberOfDocuments":(\d+)') { [int]$Matches[1] } else { -1 }
Mark ($resN -gt $delN) 'meili-reindexed-on-restore' "docs $delN -> $resN"
$aliceSees2 = $false
try { $t = Invoke-RestMethod -Uri "$base/api/v3/topics/$tid" -WebSession $ali; $aliceSees2 = $true } catch {}
Mark $aliceSees2 'restored-topic-visible-to-alice' ''

Write-Host '=== [10] 搜索页面全链（filter:search.query → meili → fail-closed 不炸）==='
$sr = Invoke-WebRequest -Uri "$base/search?query=zebra42&in=titlesposts" -WebSession $ali -UseBasicParsing
Mark ($sr.StatusCode -eq 200) 'search-page-200' "len=$($sr.Content.Length)"

Write-Host '=== [11] Centrifugo publish 凭证链（NodeBB → centrifugo HTTP API）==='
$pub = docker exec odysseia-nodebb-1 node -e "fetch('http://centrifugo:8000/api/publish',{method:'POST',headers:{'X-API-Key':process.env.CENTRIFUGO_HTTP_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({channel:'smoke:test',data:{ok:1}})}).then(r=>{console.error('HTTP '+r.status);return r.text()}).then(t=>console.log(t||'{}')).catch(e=>{console.error('ERR '+e.message);console.log('{}')})" 2>&1
$httpLine = ($pub | Select-String -Pattern 'HTTP (\d+)' | Select-Object -First 1)
Mark ($httpLine -and $httpLine.ToString() -match 'HTTP 200') 'centrifugo-publish-auth' $httpLine

Write-Host ''
Write-Host "===== SMOKE RESULT: $PASS passed, $FAIL failed ====="
if ($FAIL -gt 0) { exit 1 }
