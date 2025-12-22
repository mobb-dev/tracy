## Cursor Debug instructions

1. Update the .env values with these values for local development:

```
API_URL="http://localhost:8080/v1/graphql"
WEB_APP_URL="http://localhost:5173"
```

2. Run (this will overwrite your .env file, so, check which values you need or want to use)

```bash
package.sh
```

3. Open Cursor

If the extension is already installed,

- Go to Extensions and uninstall
- Restart extensions

4. Go to the file `clients/cursor_ext/mobb-ai-tracer-VERSION.vsix`

5. Right click, install extension

6. Open the Output panel and pick the channel you need:
    - `mobb-ai-tracer` → extension output channel
