#!/bin/sh
# Builds renderer/ui-helper.jar (the on-phone helper for Test automation) from uihelper/src.
# Needs a JDK (17+) and the Android SDK (ANDROID_HOME or ~/Library/Android/sdk) with a platform and build-tools.
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
TOOLS="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
rm -rf build && mkdir -p build/classes build/dex
javac -source 8 -target 8 -Xlint:-options -cp "$PLATFORM/android.jar" -d build/classes $(find src -name '*.java')
"$TOOLS/d8" --release --min-api 26 --lib "$PLATFORM/android.jar" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q -X ../ui-helper.jar classes.dex)
cp build/ui-helper.jar ../renderer/ui-helper.jar
rm -rf build
echo "Built renderer/ui-helper.jar ($(wc -c < ../renderer/ui-helper.jar | tr -d ' ') bytes)"
