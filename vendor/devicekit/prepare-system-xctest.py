"""Package DeviceKit with XCTest supplied by the mounted developer image.

The upstream 0.0.18 IPA embeds Xcode 16.4 XCTest libraries. Its runner already
searches /System/Developer/{Library/Frameworks,usr/lib}; removing the embedded
copies lets it use the XCTest runtime matched to the device.
No executable is modified. Signing must happen separately, with private assets.
"""

from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib


root = Path(__file__).resolve().parent / "0.0.18"
source = root / "devicekit-ios-runner-0.0.18.ipa"
output = root / "devicekit-ios-runner-0.0.18-system-xctest-unsigned.ipa"
expected = "45457d3f11de2b5370b14ba45e6c8502328e28825ee8222e8517245898a4c57f"
assert hashlib.sha256(source.read_bytes()).hexdigest() == expected, "Upstream SHA256 mismatch"

app = "Payload/devicekit-iosUITests-Runner.app/"
with ZipFile(source) as original, ZipFile(output, "w", ZIP_DEFLATED) as prepared:
    for entry in original.infolist():
        if entry.filename.startswith(app + "Frameworks/"):
            continue
        if "_CodeSignature" in Path(entry.filename).parts:
            continue
        prepared.writestr(entry, original.read(entry.filename))

print(output.name, hashlib.sha256(output.read_bytes()).hexdigest())
