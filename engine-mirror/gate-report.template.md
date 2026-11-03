# Gate report: {{shortSha}} ({{upstreamTag}}) - {{result}}

| | |
|---|---|
| Candidate | `{{sha}}` |
| Upstream | {{upstreamTag}} |
| Compared with `stable` | {{stableSha}} ([upstream compare]({{compareUrl}})) |
| Bundled Node (from the app repo) | {{nodeVersion}} |
| OpenTac shell under test | {{shellRef}} |
| Gate run | {{runUrl}} |
| Generated | {{generatedAt}} |

{{failure}}

## Upstream's own checks

{{timings}}

## Contract checks

{{contracts}}

## Size and dependency diff

{{size}}

{{deps}}

## OpenTac compatibility smoke

{{smoke}}

---
CI WebGL is software-rendered: this report proves the engine boots and the shell's contracts hold, not that rendering performs. That is what the canary is for.
