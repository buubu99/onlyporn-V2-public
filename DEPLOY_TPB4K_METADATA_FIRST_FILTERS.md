# Deploy OnlyPorn 2.7.0-alpha.14

Use the guarded deployment script distributed with the alpha.13 ZIP:

```bash
chmod +x "$HOME/Downloads/DEPLOY_ONLYPORN_TPB4K_METADATA_FIRST_FILTERS_2.7.0_ALPHA13.sh"
bash "$HOME/Downloads/DEPLOY_ONLYPORN_TPB4K_METADATA_FIRST_FILTERS_2.7.0_ALPHA13.sh"
```

The script requires GitHub `origin/main` to report `2.7.0-alpha.12`, creates a
remote backup, installs the exact ZIP, requests TPDB and StashDB keys through
hidden terminal input, executes deterministic and live gates, pushes a feature
commit, fast-forwards `main` only if it did not change, waits for Render and
runs the production metadata-first smoke.

No API key is written to the repository or printed by the script.
