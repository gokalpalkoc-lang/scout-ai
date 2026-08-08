import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

import { BridgeRequest, handleBridgeCall } from '../lib/modules/bridge';
import { escapeForInjection, wrapModuleHtml } from '../lib/modules/sandbox';
import { Module } from '../lib/modules/types';
import { errorMessage } from '../lib/util';
import { useTheme } from '../theme';
import { Text } from './ui';

/**
 * Runs one module.
 *
 * The WebView is locked down deliberately: navigation is refused, file access is
 * off, and the document's CSP blocks all network traffic. `postMessage` is the
 * only channel, and every call goes through `handleBridgeCall`, which checks the
 * module's granted capabilities before touching the database.
 */
export function ModuleHost({
  module,
  onError,
  minHeight = 260,
}: {
  module: Module;
  onError?: (message: string) => void;
  /** Grows to fit content; this is the floor while loading. */
  minHeight?: number;
}) {
  const t = useTheme();
  const webRef = useRef<WebView>(null);
  const [height, setHeight] = useState(minHeight);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const html = useMemo(
    () => wrapModuleHtml({ fragment: module.html, color: t.color, scheme: t.scheme }),
    // Re-wrap when the code or theme changes, not on every render.
    [module.html, module.version, t.color, t.scheme],
  );

  const reply = useCallback((id: string, ok: boolean, data?: unknown, error?: string) => {
    const envelope = escapeForInjection(JSON.stringify({ id, ok, data, error }));
    webRef.current?.injectJavaScript(`window.__scoutResolve(${envelope}); true;`);
  }, []);

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let request: BridgeRequest;
      try {
        request = JSON.parse(event.nativeEvent.data) as BridgeRequest;
      } catch {
        return; // Not ours; ignore rather than crash the host.
      }

      switch (request.kind) {
        case 'ready':
          setLoading(false);
          return;

        case 'resize': {
          const next = Math.round(request.height ?? 0);
          // Clamp: a runaway layout should not produce an unbounded view.
          if (next > 0) setHeight(Math.min(Math.max(next + 8, minHeight), 4000));
          return;
        }

        case 'error':
          onError?.(request.message ?? 'Unknown module error');
          return;

        case 'call': {
          if (!request.id || !request.method) return;
          try {
            const result = await handleBridgeCall(request.method, request.params ?? {}, module);
            reply(request.id, result.ok, result.data, result.error);
          } catch (e) {
            reply(request.id, false, undefined, errorMessage(e));
          }
          return;
        }
      }
    },
    [module, minHeight, onError, reply],
  );

  if (fatal) {
    return (
      <View
        style={{
          padding: t.spacing.lg,
          backgroundColor: t.color.dangerSoft,
          borderRadius: t.radius.md,
        }}
      >
        <Text variant="label" tone="danger">
          This module could not run
        </Text>
        <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
          {fatal}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        height,
        borderRadius: t.radius.md,
        overflow: 'hidden',
        backgroundColor: t.color.bg,
      }}
    >
      <WebView
        ref={webRef}
        originWhitelist={['about:*']}
        source={{ html }}
        onMessage={onMessage}
        // Hardening: no navigation, no file access, no new windows, no storage APIs
        // beyond what the page itself keeps in memory.
        onShouldStartLoadWithRequest={(req) => req.url === 'about:blank' || req.url.startsWith('data:')}
        setSupportMultipleWindows={false}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsInlineMediaPlayback={false}
        mediaPlaybackRequiresUserAction
        cacheEnabled={false}
        incognito
        scrollEnabled={false}
        nestedScrollEnabled={false}
        showsVerticalScrollIndicator={false}
        onError={(e) => setFatal(e.nativeEvent.description || 'The module failed to load.')}
        onRenderProcessGone={() => setFatal('The module crashed and was stopped.')}
        style={{ backgroundColor: 'transparent' }}
      />
      {loading ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: t.color.bg,
          }}
        >
          <ActivityIndicator color={t.color.primary} />
        </View>
      ) : null}
    </View>
  );
}
