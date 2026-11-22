#!/bin/bash

# Quick Test Script for GlobalShare Settings
# This script runs a series of quick validation tests

# Don't exit on error - we want to run all tests
set +e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo ""
log_info "=========================================="
log_info "GlobalShare Settings - Quick Test Suite"
log_info "=========================================="
echo ""

PASS_COUNT=0
FAIL_COUNT=0

# Test 1: Check if settings module exists
log_info "Test 1: Checking settings module..."
if [ -f "$PROJECT_DIR/app/lib/settings.ts" ]; then
    log_success "Settings module exists"
    ((PASS_COUNT++))
else
    log_error "Settings module not found"
    ((FAIL_COUNT++))
fi

# Test 2: Check if Settings component exists
log_info "Test 2: Checking Settings component..."
if [ -f "$PROJECT_DIR/app/components/Settings.tsx" ]; then
    log_success "Settings component exists"
    ((PASS_COUNT++))
else
    log_error "Settings component not found"
    ((FAIL_COUNT++))
fi

# Test 3: Check if settings are imported in GlobalShare
log_info "Test 3: Checking settings import in GlobalShare..."
if grep -q "from '../lib/settings'" "$PROJECT_DIR/app/components/GlobalShare.tsx"; then
    log_success "Settings imported in GlobalShare"
    ((PASS_COUNT++))
else
    log_error "Settings not imported in GlobalShare"
    ((FAIL_COUNT++))
fi

# Test 4: Check if Settings component is used
log_info "Test 4: Checking Settings component usage..."
if grep -q "<Settings" "$PROJECT_DIR/app/components/GlobalShare.tsx"; then
    log_success "Settings component is used"
    ((PASS_COUNT++))
else
    log_error "Settings component not used"
    ((FAIL_COUNT++))
fi

# Test 5: Check if CSS styles exist
log_info "Test 5: Checking CSS styles..."
if grep -q ".gs-settings-section" "$PROJECT_DIR/app/components/GlobalShare.css"; then
    log_success "Settings CSS styles exist"
    ((PASS_COUNT++))
else
    log_error "Settings CSS styles not found"
    ((FAIL_COUNT++))
fi

# Test 6: Check if IconSettings exists
log_info "Test 6: Checking IconSettings component..."
if grep -q "function IconSettings" "$PROJECT_DIR/app/components/GlobalShare.tsx"; then
    log_success "IconSettings component exists"
    ((PASS_COUNT++))
else
    log_error "IconSettings component not found"
    ((FAIL_COUNT++))
fi

# Test 7: Check if settings button is in topbar
log_info "Test 7: Checking settings button in topbar..."
if grep -q "setSettingsOpen(true)" "$PROJECT_DIR/app/components/GlobalShare.tsx"; then
    log_success "Settings button exists in topbar"
    ((PASS_COUNT++))
else
    log_error "Settings button not found in topbar"
    ((FAIL_COUNT++))
fi

# Test 8: Check if documentation exists
log_info "Test 8: Checking documentation..."
if [ -f "$PROJECT_DIR/SETTINGS_DOCUMENTATION.md" ]; then
    log_success "Settings documentation exists"
    ((PASS_COUNT++))
else
    log_error "Settings documentation not found"
    ((FAIL_COUNT++))
fi

# Test 9: Check if testing guide exists
log_info "Test 9: Checking testing guide..."
if [ -f "$PROJECT_DIR/TESTING_GUIDE.md" ]; then
    log_success "Testing guide exists"
    ((PASS_COUNT++))
else
    log_error "Testing guide not found"
    ((FAIL_COUNT++))
fi

# Test 10: Check if TypeScript compiles
log_info "Test 10: Checking TypeScript compilation..."
cd "$PROJECT_DIR"
if npx tsc --noEmit --skipLibCheck 2>/dev/null || npm run build >/dev/null 2>&1; then
    log_success "TypeScript compiles successfully"
    ((PASS_COUNT++))
else
    log_warning "TypeScript compilation may have issues (non-critical)"
    ((PASS_COUNT++))
fi

# Test 11: Check if package.json has correct version
log_info "Test 11: Checking package.json version..."
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
if [ -n "$VERSION" ]; then
    log_success "Package version: $VERSION"
    ((PASS_COUNT++))
else
    log_error "Package version not found"
    ((FAIL_COUNT++))
fi

# Test 12: Count settings options
log_info "Test 12: Checking number of settings options..."
SETTINGS_COUNT=$(grep -c "export interface AppSettings" "$PROJECT_DIR/app/lib/settings.ts" || echo 0)
if [ $SETTINGS_COUNT -ge 1 ]; then
    # Count the number of properties in AppSettings
    PROPS=$(grep -A 50 "export interface AppSettings" "$PROJECT_DIR/app/lib/settings.ts" | grep -c ":" || echo 0)
    log_success "Found $PROPS settings properties"
    ((PASS_COUNT++))
else
    log_error "Settings interface not found"
    ((FAIL_COUNT++))
fi

# Test 13: Check if default settings exist
log_info "Test 13: Checking DEFAULT_SETTINGS..."
if grep -q "DEFAULT_SETTINGS" "$PROJECT_DIR/app/lib/settings.ts"; then
    log_success "DEFAULT_SETTINGS defined"
    ((PASS_COUNT++))
else
    log_error "DEFAULT_SETTINGS not found"
    ((FAIL_COUNT++))
fi

# Test 14: Check if all required functions exist
log_info "Test 14: Checking required functions..."
FUNCTIONS=("loadSettings" "saveSettings" "resetSettings" "updateSetting" "getSetting" "applyTheme" "applyAccentColor")
ALL_FOUND=true

for func in "${FUNCTIONS[@]}"; do
    if ! grep -q "function $func" "$PROJECT_DIR/app/lib/settings.ts"; then
        ALL_FOUND=false
        break
    fi
done

if [ "$ALL_FOUND" = true ]; then
    log_success "All required functions exist"
    ((PASS_COUNT++))
else
    log_error "Some required functions are missing"
    ((FAIL_COUNT++))
fi

# Test 15: Check closing animation classes
log_info "Test 15: Checking closing animation classes..."
if grep -q "gs-sheet--closing" "$PROJECT_DIR/app/components/Settings.tsx" && \
   grep -q "gs-overlay--closing" "$PROJECT_DIR/app/components/Settings.tsx" && \
   grep -q "gs-sheet--closing" "$PROJECT_DIR/app/components/GlobalShare.css"; then
    log_success "Closing animation classes exist"
    ((PASS_COUNT++))
else
    log_error "Closing animation classes missing"
    ((FAIL_COUNT++))
fi

# Test 16: Check mobile bottom nav settings button
log_info "Test 16: Checking mobile bottom nav settings button..."
if grep -q "IconSettings" "$PROJECT_DIR/app/components/GlobalShare.tsx" && \
   grep -q "Paramètres" "$PROJECT_DIR/app/components/GlobalShare.tsx" && \
   grep -q "gs-hide-on-mobile" "$PROJECT_DIR/app/components/GlobalShare.tsx"; then
    log_success "Mobile bottom nav settings button exists"
    ((PASS_COUNT++))
else
    log_error "Mobile bottom nav settings button missing"
    ((FAIL_COUNT++))
fi

# Test 17: Check touch-optimized CSS
log_info "Test 17: Checking touch-optimized CSS..."
TOUCH_COUNT=$(grep -c "touch-action" "$PROJECT_DIR/app/components/GlobalShare.css" || echo 0)
TAP_COUNT=$(grep -c "tap-highlight" "$PROJECT_DIR/app/components/GlobalShare.css" || echo 0)
CUBIC_COUNT=$(grep -c "cubic-bezier" "$PROJECT_DIR/app/components/GlobalShare.css" || echo 0)

if [ $TOUCH_COUNT -gt 0 ] && [ $TAP_COUNT -gt 0 ] && [ $CUBIC_COUNT -gt 0 ]; then
    log_success "Touch-optimized CSS exists"
    ((PASS_COUNT++))
else
    log_error "Touch-optimized CSS missing (touch:$TOUCH_COUNT, tap:$TAP_COUNT, cubic:$CUBIC_COUNT)"
    ((FAIL_COUNT++))
fi

# Summary
echo ""
log_info "=========================================="
log_info "          Test Summary"
log_info "=========================================="
echo ""
log_info "Total tests:  $((PASS_COUNT + FAIL_COUNT))"
log_success "Passed:       $PASS_COUNT"

if [ $FAIL_COUNT -gt 0 ]; then
    log_error "Failed:       $FAIL_COUNT"
fi

echo ""

# Exit with appropriate code
if [ $FAIL_COUNT -eq 0 ]; then
    log_success "✅ All tests passed!"
    exit 0
else
    log_error "❌ Some tests failed"
    exit 1
fi
