'use client';

// EmailPreview (DS-10): email HTML (a signature, later a draft) rendered
// in a sandboxed iframe, never into the app's own document.
//
// Before DS-10 the signature previews injected the HTML into the page
// (React's raw-HTML prop): the app's stylesheets restyled it, so what
// the operator saw was not what a mail client shows (every <input>, <p>
// and <a> took the app's look once base.css styles bare controls), and an
// operator-pasted `<img onerror>` ran as the app.
//
// Here the HTML is the body of its own document (srcdoc):
//   - none of the app's CSS reaches it: a mail-client canvas (light scheme,
//     the system font, 14px) is all it gets;
//   - sandbox without allow-scripts: no script, inline handler, form
//     submission, popup or top navigation runs. allow-same-origin only so
//     this component can read the content height and size the frame to it;
//   - a Content-Security-Policy that loads images and nothing else.

import { useCallback, useEffect, useRef, useState } from 'react';
import { cssVars } from '@/lib/ui/css-vars';
import { EMAIL_PREVIEW_SANDBOX, emailPreviewDocument } from './email-preview-document';
import styles from './EmailPreview.module.css';

export interface EmailPreviewProps {
  /** The email HTML (body content, not a whole document). */
  html: string;
  /** Names the frame for assistive tech, e.g. "Signature preview". */
  title: string;
  className?: string;
}

export function EmailPreview({ html, title, className }: Readonly<EmailPreviewProps>) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const body = frame.current?.contentDocument?.body;
    if (!body) return;
    const next = Math.ceil(body.getBoundingClientRect().height);
    if (next > 0) setHeight(next);
  }, []);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    // The frame may have loaded before hydration attached onLoad.
    if (el.contentDocument?.readyState === 'complete') measure();
    if (typeof ResizeObserver === 'undefined') return;
    // A narrower frame rewraps the text: measure again when the width changes.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <iframe
      ref={frame}
      className={className ? `${styles.frame} ${className}` : styles.frame}
      title={title}
      sandbox={EMAIL_PREVIEW_SANDBOX}
      srcDoc={emailPreviewDocument(html)}
      referrerPolicy="no-referrer"
      onLoad={measure}
      data-email-preview=""
      style={height ? cssVars({ '--email-preview-h': `${height}px` }) : undefined}
    />
  );
}
