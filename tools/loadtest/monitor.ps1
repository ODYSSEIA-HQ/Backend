param(
    [string]$Target = 'odysseia-resume-full',
    [string]$Output = (Join-Path $PSScriptRoot 'results/resume-full-resources.jsonl'),
    [int]$IntervalSeconds = 15,
    [int]$MaxSamples = 40
)
$ErrorActionPreference = 'Stop'
# Record resources and pressure only; never read environment variables or credentials.
for ($sample = 0; $sample -lt $MaxSamples; $sample++) {
    $running = docker ps --filter "name=^/$Target`$" --format '{{.Names}}'
    if (-not $running) { break }
    $names = @(docker ps --filter label=com.docker.compose.project=odysseia --format '{{.Names}}') + @($Target)
    $stats = @(docker stats --no-stream --format '{{json .}}' @names | ForEach-Object { $_ | ConvertFrom-Json })
    $pressure = @(docker exec odysseia-cadvisor-1 cat /rootfs/proc/pressure/memory /rootfs/proc/pressure/io)
    $events = @(docker exec odysseia-nodebb-1 cat /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.swap.current)
    $record = [ordered]@{
        utc = [DateTime]::UtcNow.ToString('o')
        containers = $stats
        pressure = $pressure
        nodebbMemory = $events
    }
    $record | ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath $Output -Encoding utf8
    Write-Output "resource sample $sample saved"
    Start-Sleep -Seconds $IntervalSeconds
}
