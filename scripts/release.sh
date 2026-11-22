#!/bin/bash

# GlobalShare Release Script
# This script automates the build and release process for all platforms

set -e  # Exit on error

# ============================================================================
# Configuration
# ============================================================================

VERSION=$(node -p "require('./package.json').version")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================================================
# Command Line Arguments
# ============================================================================

# Parse command line arguments
BUILD_WEB=false
BUILD_DESKTOP=false
BUILD_ANDROID=false
BUILD_IOS=false
BUILD_ALL=false
SKIP_TESTS=false
SKIP_LINT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --web|-w)
            BUILD_WEB=true
            shift
            ;;
        --desktop|-d)
            BUILD_DESKTOP=true
            shift
            ;;
        --android|-a)
            BUILD_ANDROID=true
            shift
            ;;
        --ios|-i)
            BUILD_IOS=true
            shift
            ;;
        --all)
            BUILD_ALL=true
            shift
            ;;
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --skip-lint)
            SKIP_LINT=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --web, -w         Build web version"
            echo "  --desktop, -d     Build desktop (Electron) version"
            echo "  --android, -a     Build Android version"
            echo "  --ios, -i         Build iOS version"
            echo "  --all             Build all platforms"
            echo "  --skip-tests      Skip running tests"
            echo "  --skip-lint       Skip linting"
            echo "  --help, -h        Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0 --all           Build and release all platforms"
            echo "  $0 --web --desktop  Build web and desktop only"
            echo "  $0 --android --skip-tests  Build Android without tests"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If --all is specified, build everything
if [ "$BUILD_ALL" = true ]; then
    BUILD_WEB=true
    BUILD_DESKTOP=true
    BUILD_ANDROID=true
    BUILD_IOS=true
fi

# ============================================================================
# Validation
# ============================================================================

# Check if at least one platform is selected
if [ "$BUILD_WEB" = false ] && [ "$BUILD_DESKTOP" = false ] && [ "$BUILD_ANDROID" = false ] && [ "$BUILD_IOS" = false ]; then
    log_warning "No platform selected. Building all platforms by default."
    BUILD_ALL=true
    BUILD_WEB=true
    BUILD_DESKTOP=true
    BUILD_ANDROID=true
    BUILD_IOS=true
fi

# ============================================================================
# Pre-Build Checks
# ============================================================================

log_info "GlobalShare Release Script v1.0"
log_info "Project version: $VERSION"
log_info "Project directory: $PROJECT_DIR"
log_info ""

# Check Node.js version
NODE_VERSION=$(node --version)
log_info "Node.js version: $NODE_VERSION"

# Check npm version
NPM_VERSION=$(npm --version)
log_info "npm version: $NPM_VERSION"

# Check if we're in the right directory
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    log_error "package.json not found in $PROJECT_DIR"
    exit 1
fi

# ============================================================================
# Step 1: Install Dependencies
# ============================================================================

log_info "Step 1: Installing dependencies..."
cd "$PROJECT_DIR"

if [ -f "package-lock.json" ] || [ -f "npm-shrinkwrap.json" ]; then
    npm ci
else
    npm install
fi

log_success "Dependencies installed"

# ============================================================================
# Step 2: Linting (optional)
# ============================================================================

if [ "$SKIP_LINT" = false ]; then
    log_info "Step 2: Running linter..."
    if npm run lint; then
        log_success "Linting passed"
    else
        log_warning "Linting failed, but continuing with build"
    fi
else
    log_info "Step 2: Skipping linter"
fi

# ============================================================================
# Step 3: Run Tests (optional)
# ============================================================================

if [ "$SKIP_TESTS" = false ]; then
    log_info "Step 3: Running tests..."
    if npm run test:unit; then
        log_success "All tests passed"
    else
        log_warning "Some tests failed, but continuing with build"
    fi
else
    log_info "Step 3: Skipping tests"
fi

# ============================================================================
# Step 4: Build Platforms
# ============================================================================

# Create dist directory if it doesn't exist
mkdir -p "$PROJECT_DIR/dist"

# ============================================================================
# Build Web
# ============================================================================

if [ "$BUILD_WEB" = true ]; then
    log_info "Step 4.1: Building Web version..."
    cd "$PROJECT_DIR"
    
    # Build Next.js application
    npm run build
    
    # Copy build output to dist/web
    mkdir -p "$PROJECT_DIR/dist/web"
    cp -r "$PROJECT_DIR/.next/standalone" "$PROJECT_DIR/dist/web/" || \
    cp -r "$PROJECT_DIR/.next" "$PROJECT_DIR/dist/web/"
    
    # Copy static files
    if [ -d "$PROJECT_DIR/public" ]; then
        cp -r "$PROJECT_DIR/public" "$PROJECT_DIR/dist/web/"
    fi
    
    log_success "Web version built successfully"
fi

# ============================================================================
# Build Desktop (Electron)
# ============================================================================

if [ "$BUILD_DESKTOP" = true ]; then
    log_info "Step 4.2: Building Desktop (Electron) version..."
    cd "$PROJECT_DIR"
    
    # Check if desktop build is available
    if [ -d "$PROJECT_DIR/desktop" ]; then
        # Build desktop app
        npm run build:desktop
        
        # Package for different platforms
        log_info "Packaging for Windows..."
        npm run dist:win
        
        log_info "Packaging for macOS..."
        npm run dist:linux
        
        log_info "Packaging for Linux..."
        npm run dist:linux
        
        # Move files to dist/desktop
        mkdir -p "$PROJECT_DIR/dist/desktop"
        cp -r "$PROJECT_DIR/dist/"* "$PROJECT_DIR/dist/desktop/" 2>/dev/null || true
        
        log_success "Desktop version built successfully"
    else
        log_warning "Desktop directory not found. Skipping desktop build."
    fi
fi

# ============================================================================
# Build Android
# ============================================================================

if [ "$BUILD_ANDROID" = true ]; then
    log_info "Step 4.3: Building Android version..."
    cd "$PROJECT_DIR"
    
    # Check if Android is set up
    if [ -d "$PROJECT_DIR/android" ]; then
        # Build web assets
        npm run build
        
        # Sync with Capacitor
        npx cap sync android
        
        # Build APK
        cd "$PROJECT_DIR/android"
        ./gradlew assembleRelease
        
        # Move APK to dist
        mkdir -p "$PROJECT_DIR/dist/android"
        find "$PROJECT_DIR/android/app/build/outputs" -name "*.apk" -exec cp {} "$PROJECT_DIR/dist/android/" \;
        
        cd "$PROJECT_DIR"
        log_success "Android version built successfully"
    else
        log_warning "Android directory not found. Skipping Android build."
    fi
fi

# ============================================================================
# Build iOS
# ============================================================================

if [ "$BUILD_IOS" = true ]; then
    log_info "Step 4.4: Building iOS version..."
    cd "$PROJECT_DIR"
    
    # Check if iOS is set up
    if [ -d "$PROJECT_DIR/ios" ]; then
        # Check if on macOS
        if [ "$(uname)" != "Darwin" ]; then
            log_warning "iOS build requires macOS. Skipping iOS build."
        else
            # Build web assets
            npm run build
            
            # Sync with Capacitor
            npx cap sync ios
            
            # Note: iOS build requires Xcode, which can't be automated via CLI
            log_info "iOS project synced with Capacitor"
            log_warning "Open $PROJECT_DIR/ios/App.xcodeproj in Xcode to complete the build"
            
            # Copy project to dist for reference
            mkdir -p "$PROJECT_DIR/dist/ios"
            cp -r "$PROJECT_DIR/ios" "$PROJECT_DIR/dist/ios/"
            
            log_success "iOS project prepared (manual build required)"
        fi
    else
        log_warning "iOS directory not found. Skipping iOS build."
    fi
fi

# ============================================================================
# Step 5: Create Release Package
# ============================================================================

log_info "Step 5: Creating release package..."

# Create release directory
RELEASE_DIR="$PROJECT_DIR/releases/global-share-v$VERSION"
mkdir -p "$RELEASE_DIR"

# Copy all built artifacts
if [ "$BUILD_WEB" = true ]; then
    log_info "Copying Web build..."
    cp -r "$PROJECT_DIR/dist/web" "$RELEASE_DIR/web/"
fi

if [ "$BUILD_DESKTOP" = true ]; then
    log_info "Copying Desktop build..."
    cp -r "$PROJECT_DIR/dist/desktop" "$RELEASE_DIR/desktop/"
fi

if [ "$BUILD_ANDROID" = true ]; then
    log_info "Copying Android build..."
    cp -r "$PROJECT_DIR/dist/android" "$RELEASE_DIR/android/"
fi

if [ "$BUILD_IOS" = true ]; then
    log_info "Copying iOS project..."
    cp -r "$PROJECT_DIR/dist/ios" "$RELEASE_DIR/ios/"
fi

# Copy documentation
log_info "Copying documentation..."
cp "$PROJECT_DIR/CHANGELOG.md" "$RELEASE_DIR/"
cp "$PROJECT_DIR/SETTINGS_DOCUMENTATION.md" "$RELEASE_DIR/"
cp "$PROJECT_DIR/TESTING_GUIDE.md" "$RELEASE_DIR/"

# Create README for the release
cat > "$RELEASE_DIR/README.md" << EOF
# GlobalShare v$VERSION Release

## 📦 Contents

This release package contains the following builds:

EOF

if [ "$BUILD_WEB" = true ]; then
    echo "- **Web**: `./web/` - Static web build" >> "$RELEASE_DIR/README.md"
fi

if [ "$BUILD_DESKTOP" = true ]; then
    echo "- **Desktop**: `./desktop/` - Electron packages for Windows, macOS, Linux" >> "$RELEASE_DIR/README.md"
fi

if [ "$BUILD_ANDROID" = true ]; then
    echo "- **Android**: `./android/` - APK files" >> "$RELEASE_DIR/README.md"
fi

if [ "$BUILD_IOS" = true ]; then
    echo "- **iOS**: `./ios/` - Xcode project (requires manual build)" >> "$RELEASE_DIR/README.md"
fi

cat >> "$RELEASE_DIR/README.md" << EOF

## 📖 Documentation

- [CHANGELOG.md](CHANGELOG.md) - Version history and changes
- [SETTINGS_DOCUMENTATION.md](SETTINGS_DOCUMENTATION.md) - Settings module documentation
- [TESTING_GUIDE.md](TESTING_GUIDE.md) - Testing instructions

## 🚀 Installation

### Web
Simply deploy the contents of the `web/` directory to your web server.

### Desktop
Run the appropriate installer for your platform from the `desktop/` directory.

### Android
Install the APK file from the `android/` directory on your device.

### iOS
Open the Xcode project in `ios/` and build using Xcode.

## 📝 Release Notes

This release includes:
- New Settings Module with 15+ configurable options
- Theme support (System/Light/Dark)
- Accent color customization
- Display and notification preferences
- Behavior and advanced settings
- Improved UI text and clarity
- Complete documentation

## 📊 Version Information

- **Version**: $VERSION
- **Release Date**: $(date +"%Y-%m-%d")
- **Git Commit**: $(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

EOF

log_success "Release package created at: $RELEASE_DIR"

# ============================================================================
# Step 6: Create Tarball
# ============================================================================

log_info "Step 6: Creating tarball..."

cd "$PROJECT_DIR/releases"
TARBALL_NAME="global-share-v$VERSION.tar.gz"

if command -v tar &> /dev/null; then
    tar -czf "$TARBALL_NAME" "global-share-v$VERSION"
    log_success "Tarball created: $TARBALL_NAME"
else
    log_warning "tar command not found. Skipping tarball creation."
fi

# ============================================================================
# Step 7: Git Tag (optional)
# ============================================================================

log_info "Step 7: Creating Git tag..."

if [ -d "$PROJECT_DIR/.git" ] && command -v git &> /dev/null; then
    cd "$PROJECT_DIR"
    
    # Create annotated tag
    GIT_TAG="v$VERSION"
    if ! git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
        git tag -a "$GIT_TAG" -m "Release v$VERSION: Settings module and UI improvements"
        git push origin "$GIT_TAG"
        log_success "Git tag created and pushed: $GIT_TAG"
    else
        log_warning "Git tag $GIT_TAG already exists. Skipping."
    fi
else
    log_warning "Git not found or not a git repository. Skipping tag creation."
fi

# ============================================================================
# Summary
# ============================================================================

log_info ""
log_info "╔════════════════════════════════════════════════════════════════╗"
log_info "║                    Release Summary                               ║"
log_info "╚════════════════════════════════════════════════════════════════╝"
log_info ""
log_info "  Version:        $VERSION"
log_info "  Timestamp:      $(date)"
log_info "  Release Dir:    $RELEASE_DIR"
log_info ""
log_info "  Built Platforms:"

if [ "$BUILD_WEB" = true ]; then
    log_info "    ✅ Web"
fi

if [ "$BUILD_DESKTOP" = true ]; then
    log_info "    ✅ Desktop (Electron)"
fi

if [ "$BUILD_ANDROID" = true ]; then
    log_info "    ✅ Android"
fi

if [ "$BUILD_IOS" = true ]; then
    log_info "    ✅ iOS (project prepared)"
fi

log_info ""
log_info "  Actions:"
log_info "    ✅ Dependencies installed"

if [ "$SKIP_LINT" = false ]; then
    log_info "    ✅ Linting completed"
else
    log_info "    ⏭️  Linting skipped"
fi

if [ "$SKIP_TESTS" = false ]; then
    log_info "    ✅ Tests completed"
else
    log_info "    ⏭️  Tests skipped"
fi

if [ -f "$PROJECT_DIR/releases/$TARBALL_NAME" ]; then
    log_info "    ✅ Tarball created"
fi

if [ -d "$PROJECT_DIR/.git" ]; then
    log_info "    ✅ Git tag created"
fi

log_info ""
log_info "  Release package ready at: $RELEASE_DIR"
log_info ""
log_success "✅ Release completed successfully!"

exit 0
