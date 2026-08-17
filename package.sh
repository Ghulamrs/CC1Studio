#!/bin/sh
# Build cc1-studio-1.0.0.vsix, the installable package.
#
#   ./package.sh
#   code --install-extension cc1-studio-1.0.0.vsix
#
# A .vsix is a zip holding the extension plus two XML files describing it, so
# this needs `zip` and nothing else - no npm, no vsce, no node. That matters:
# none of the three machines this runs on has node outside VS Code's own.
#
# Why package at all, rather than copying the folder into ~/.vscode/extensions:
# copying looks like it works. The editor lists the extension, `code
# --list-extensions` prints it, and its entry appears in extensions.json - and
# it never activates. A minimal two-file extension installed the same way does
# not activate either, so it is the method and not the code. Installing the
# .vsix through the editor is the supported path, and the one that runs.
#
# The package contains only text: JavaScript, JSON and a grammar. No compiler
# and no binary of any kind travels in it, which is the whole point - each
# machine builds its own cc1 and the slot in cc/ points at it.

set -eu

studio=$(cd "$(dirname "$0")" && pwd)
name=cc1-studio
version=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$studio/extension/package.json" | head -1)
out=$studio/$name-$version.vsix
staging=${TMPDIR:-/tmp}/cc1-studio-vsix.$$

rm -rf "$staging"
mkdir -p "$staging/extension"

# Only what the extension needs at runtime. The tests and their fixtures are
# for the source tree, not for an installed copy.
for item in package.json extension.js lib syntaxes language-configuration.json; do
  cp -R "$studio/extension/$item" "$staging/extension/"
done
cp "$studio/README.md" "$staging/extension/README.md"

cat > "$staging/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$name" Version="$version" Publisher="compiler-c" />
    <DisplayName>CC1 Studio</DisplayName>
    <Description xml:space="preserve">An editing and build environment for cc1, the Compiler-C compiler.</Description>
    <Tags>c,compiler,assembly,cc1</Tags>
    <Categories>Programming Languages,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.75.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
XML

cat > "$staging/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
XML

rm -f "$out"
(cd "$staging" && zip -q -r -X "$out" '[Content_Types].xml' extension.vsixmanifest extension)
rm -rf "$staging"

echo "built $out"
ls -lh "$out" | awk '{print "      " $5}'
echo
echo "install it with:"
echo "    code --install-extension \"$out\""
