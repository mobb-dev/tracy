# Cursor E2E Docker Images

This directory contains Dockerfiles for running Cursor extension E2E tests in isolated environments.

## Files

- **Dockerfile** - Original multi-layer build (7.92GB)
- **Dockerfile.optimized** - Optimized single-layer build (~30-40% smaller)
- **entrypoint.sh** - Container entrypoint script

## Optimization Comparison

### Original Dockerfile (current)
- **Size**: ~7.92GB
- **Layers**: 28 layers
- **Build time**: ~5-7 minutes
- **Features**: Multiple RUN statements, incremental caching

### Optimized Dockerfile
- **Expected size**: ~5-6GB (30-40% reduction)
- **Layers**: 10 layers
- **Build time**: ~4-5 minutes (slightly faster)
- **Features**:
  - Single-layer dependency installation
  - Aggressive cleanup (removes build tools after use)
  - Uses `--no-install-recommends` everywhere
  - Cleans npm cache and temp files
  - Removes build dependencies after native module compilation

## Key Optimizations

1. **Single RUN Layer**: All apt-get installs + Cursor download + user creation + cleanup in one layer
   - Reduces layer overhead
   - Allows immediate cleanup of build artifacts

2. **Aggressive Cleanup**:
   ```dockerfile
   && apt-get remove -y build-essential python3 \
   && apt-get autoremove -y \
   && apt-get clean \
   && rm -rf /var/lib/apt/lists/* \
   && rm -rf /tmp/* \
   && npm cache clean --force
   ```

3. **Minimized Dependencies**:
   - Uses `--no-install-recommends` for all apt-get installs
   - Only installs runtime dependencies in final image
   - Removes build tools after native module compilation

4. **Combined Operations**:
   - npm install + VSIX extraction + native module rebuild + cleanup in single layer
   - Reduces intermediate layers and their associated overhead

## Usage

### Using the Original Dockerfile (current CI default)
```bash
docker build -t tracer-ext-cursor-e2e -f Dockerfile .
```

### Using the Optimized Dockerfile (recommended)
```bash
docker build -t tracer-ext-cursor-e2e -f Dockerfile.optimized .
```

### Running Tests
```bash
docker run --rm \
  -v $(pwd)/test-results:/workspace/clients/tracer_ext/test-results \
  tracer-ext-cursor-e2e
```

## Switching CI to Optimized Build

To use the optimized Dockerfile in CI, update `.github/workflows/tracy-e2e.yml`:

```yaml
- name: 🐳 Build Docker image
  uses: docker/build-push-action@v5
  with:
    context: .
    file: clients/tracer_ext/__tests__/e2e/cursor/docker/Dockerfile.optimized  # Change this line
    tags: ${{ matrix.image-tag }}
    # ...
```

## Benefits

1. **Smaller Image Size**: 30-40% size reduction
2. **Faster Builds**: Fewer layers means faster build times
3. **Lower Disk Usage**: Critical for CI runners with limited disk space (14GB free)
4. **Better Caching**: Single large layer caches better than many small layers
5. **Easier Maintenance**: Fewer RUN statements to maintain

## Trade-offs

- **Layer Caching**: Changes to dependencies invalidate larger chunks of cache
  - Mitigation: Dependencies change infrequently in E2E tests
- **Build Complexity**: Single-layer build is harder to read
  - Mitigation: Extensive comments in Dockerfile

## Testing

To test the optimized image locally:

```bash
# Build
npm run package:test
cd ../..
docker build -t tracer-ext-cursor-e2e-opt \
  -f clients/tracer_ext/__tests__/e2e/cursor/docker/Dockerfile.optimized .

# Check size
docker images tracer-ext-cursor-e2e-opt

# Run test
cd clients/tracer_ext
docker run --rm -v $(pwd)/test-results:/workspace/clients/tracer_ext/test-results \
  tracer-ext-cursor-e2e-opt
```

## Future Optimizations

Potential additional optimizations (not yet implemented):

1. **Multi-stage Build**: Separate builder stage for build tools
   - Would require careful handling of Playwright base image
   - Estimated additional 10-15% size reduction

2. **Alpine Base**: Use Alpine Linux instead of Ubuntu
   - Playwright doesn't officially support Alpine
   - Would require significant testing and compatibility work

3. **Distroless Final Stage**: Use Google Distroless images
   - Would require extensive dependency management
   - Significant complexity increase
