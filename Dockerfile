ARG BASE_IMAGE=ttyob/android-emulator:scrcpy-web-20260729
FROM ${BASE_IMAGE}

RUN if ! dpkg-query -W -f='${Status}' libatomic1 2>/dev/null | grep -q 'install ok installed'; then \
      apt-get update && apt-get install -y --no-install-recommends libatomic1 && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY vendor/hdc/linux-x64/ /app/vendor/hdc/linux-x64/
RUN cd /app/vendor/hdc/linux-x64 && sha256sum -c SHA256SUMS && ./hdc -v

COPY vendor/ios/linux-x64/ /app/vendor/ios/linux-x64/
RUN cd /app/vendor/ios/linux-x64 && sha256sum -c SHA256SUMS && \
    dpkg -i packages/*.deb && \
    idevice_id --version && ideviceinstaller --version && usbmuxd --version

COPY vendor/go-ios/ /app/vendor/go-ios/
RUN cd /app/vendor/go-ios/linux-x64 && sha256sum -c SHA256SUMS && ./ios version
RUN cd /app/vendor/go-ios/certs && sha256sum -c SHA256SUMS && \
    cp AppleRootCA.crt /usr/local/share/ca-certificates/physical-web-apple-root.crt && \
    update-ca-certificates

COPY patch-upstream.js /tmp/patch-upstream.js
RUN node /tmp/patch-upstream.js /app/dist/index.js

RUN rm -rf /app/vendor/wda /app/ios-control.js /app/ios-control-router.js && \
    rm -f /app/dist/public/ios-tools/WebDriverAgentRunner-*.ipa
COPY ui/ /app/dist/public/
COPY vendor/devicekit/ /app/vendor/devicekit/
RUN cd /app/vendor/devicekit/0.0.18 && sha256sum -c SHA256SUMS && \
    mkdir -p /app/dist/public/ios-tools && \
    cp devicekit-ios-runner-0.0.18-system-xctest-unsigned.ipa /app/dist/public/ios-tools/ && \
    cp /app/vendor/devicekit/LICENSE /app/dist/public/ios-tools/DeviceKit-LICENSE.txt
COPY gateway.js adb-devices.js hdc.js hdc-api.js hdc-stream.js websocket.js ios.js ios-api.js ios-transport.js ios-devicekit.js /app/
COPY start.sh /usr/local/bin/start-scrcpy-web

RUN chmod +x /usr/local/bin/start-scrcpy-web

ENV HDC_PATH=/app/vendor/hdc/linux-x64/hdc
ENV GO_IOS_PATH=/app/vendor/go-ios/linux-x64/ios

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
