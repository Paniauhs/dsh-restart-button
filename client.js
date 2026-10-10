/**
 * dsh-restart-button — Client half.
 *
 * Renders one caption-row button immediately left of the window's minimize
 * button, matching the native minimize / maximize / close buttons: 46 DIP wide,
 * the caption strip's own height, the platform symbol color, the same hover and
 * pressed fills, the default (not pointer) cursor, and a 1px stroke — the
 * weight Chromium draws the native caption glyphs with.
 *
 * Placement is measured, not guessed: the Window Controls Overlay API reports
 * the titlebar area Chromium leaves to the page, and everything right of it is
 * the native minimize / maximize / close group — so the inset is
 * `innerWidth - (area.x + area.width)`. Where the platform does not publish it,
 * the stylesheet's 3 x 46 DIP constant applies, and a
 * `--dsh-restart-caption-inset` declaration on `:root` overrides both.
 *
 * The click does NOT restart by itself: it opens a small confirm dialog, and
 * only its primary action asks the Host (`POST /dsh-restart/restart`) to hand
 * the restart to its helper. Under the desktop app that closes DSH and starts
 * it again, so the page goes away with it; when only the Host restarts, the
 * page waits for the server to come back and then reloads itself.
 *
 * Both the button and the dialog are PORTALED TO `document.body`, and that is
 * load-bearing. The slot's layer (`.…_overlayLayer`) carries `z-index: 20` and
 * therefore a stacking context: nothing rendered inside it can rise above a
 * surface outside it, whatever z-index the element itself declares. The
 * app's modal surfaces live outside it — the settings dialog is a body-level
 * `position: fixed; inset: 0; z-index: 1000` element whose mask deliberately
 * starts below the titlebar, so the caption strip LOOKS untouched while the
 * dialog still swallows every pointer event in it. The native minimize /
 * maximize / close buttons keep working through that, because Chromium draws
 * them outside the page; a page-drawn caption button has to leave the layer to
 * do the same.
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');

    const NS = 'dsh-restart-button';
    const STYLE_TAG = 'dsh-restart-button/caption-button.css';

    const zh = {
      'action.restart': '重启',
      'state.working': '正在重启 DSH…',
      'state.closing': 'DSH 正在关闭并重新启动…',
      'state.waiting': 'DSH 正在重启，服务恢复后本页会自动刷新…',
      'state.failed': '重启没有开始：',
      'confirm.title': '确定要重启吗？',
      'confirm.body': '重启会关闭 DSH 并重新启动，正在运行的会话会中断。',
      'confirm.cancel': '取消',
      'confirm.ok': '重启',
    };

    const en = {
      'action.restart': 'Restart',
      'state.working': 'Restarting DSH…',
      'state.closing': 'DSH is closing and starting again…',
      'state.waiting': 'DSH is restarting; this page reloads when the server is back…',
      'state.failed': 'The restart did not start: ',
      'confirm.title': 'Restart now?',
      'confirm.body': 'This closes DSH and starts it again. Running sessions are interrupted.',
      'confirm.cancel': 'Cancel',
      'confirm.ok': 'Restart',
    };

    const CSS = [
      '.dshRestartButton{',
      'position:fixed;top:0;',
      // Above every page-owned surface: the settings dialog is 1000, the
      // account overlay 1001, popovers 1100. The native caption buttons carry
      // no z-index at all — they are not in the page — so a page-drawn one has
      // to outrank the whole page to sit beside them. The overlay layer this
      // used to live in capped it at 20, which is why an open settings dialog
      // swallowed the click.
      'z-index:2000;',
      'pointer-events:auto;',
      // Three Windows caption buttons sit to the right of this one; 138px is
      // 3 x 46 DIP, their width at every display scale. A `:root` declaration
      // of --dsh-restart-caption-inset overrides it for a host that differs.
      'right:138px;',
      'right:var(--dsh-restart-caption-inset,138px);',
      'width:var(--dsh-restart-caption-width,46px);',
      'height:var(--dsh-windows-titlebar-height,40px);',
      'display:inline-flex;align-items:center;justify-content:center;',
      'margin:0;padding:0;border:0;background:transparent;',
      'color:var(--dsw-alias-label-primary);',
      'cursor:default;user-select:none;',
      '-webkit-app-region:no-drag;app-region:no-drag;',
      '}',
      '.dshRestartButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}',
      '.dshRestartButton:active{background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.28))}',
      '.dshRestartButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dshRestartButton:disabled{cursor:default}',
      '.dshRestartGlyph{',
      'display:block;',
      'width:var(--dsh-restart-glyph-size,12px);height:var(--dsh-restart-glyph-size,12px);',
      // stroke-width is in USER UNITS, so the viewBox is deliberately 1:1 with
      // CSS pixels at the default size: 1 unit = 1px here, the weight Chromium
      // draws the native caption glyphs with.
      'fill:none;stroke:currentColor;stroke-width:var(--dsh-restart-glyph-stroke,1);',
      'stroke-linecap:butt;stroke-linejoin:miter;',
      '}',
      '.dshRestartButton[data-busy] .dshRestartGlyph{animation:dshRestartSpin 900ms linear infinite}',
      '@keyframes dshRestartSpin{from{transform:rotate(0)}to{transform:rotate(-360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dshRestartButton[data-busy] .dshRestartGlyph{animation:none}}',
      // The confirm dialog. Fixed to the viewport like the button itself, and
      // above every layer the shell draws.
      '.dshRestartScrim{',
      // The caption row is not the page's to dim. Chromium draws the window
      // controls — and the opaque overlay plate behind them — ABOVE the web
      // content, so a scrim spanning the whole viewport ends up as a dark
      // rectangle with an untouched bright block in its top-right corner. Every
      // modal in this app masks from the chrome top down for that reason
      // (`.…_mask { inset: var(--dsh-frame-chrome-top, 0px) 0 0 }`); mirror it,
      // and the strip keeps one uniform appearance instead of showing a seam.
      'position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:2100;',
      'display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.38);',
      // The overlay layer itself is click-through; every entry opts back in,
      // and a dialog that cannot be clicked is not a dialog.
      'pointer-events:auto;',
      '-webkit-app-region:no-drag;app-region:no-drag;',
      '}',
      '.dshRestartDialog{',
      'box-sizing:border-box;width:min(360px,calc(100vw - 48px));',
      'padding:18px 20px 16px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-overlay);',
      'color:var(--dsw-alias-label-primary);',
      'box-shadow:0 12px 32px rgba(0,0,0,.28);',
      '}',
      '.dshRestartDialogTitle{margin:0 0 8px;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshRestartDialogBody{margin:0 0 18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dshRestartDialogActions{display:flex;justify-content:flex-end;gap:8px}',
      '.dshRestartDialogButton{',
      'height:28px;padding:0 14px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:default;',
      '}',
      '.dshRestartDialogButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}',
      '.dshRestartDialogButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshRestartDialogPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dshRestartDialogPrimary:hover{filter:brightness(1.08)}',
    ].join('');

    /**
     * The restart glyph, traced from the supplied artwork and scaled into a
     * 12-unit box, so one unit is one CSS pixel at the default size: ring centre
     * (6, 6.06) with radius 5.42 and its gap at the top (249deg -> 273deg),
     * ended at the upper left by the squared hook — a bar running left from the
     * ring's end (x 3.56 -> 0.54) plus a stem dropped to y 4.02.
     *
     * The ring is a `<circle>` with a dash pattern rather than one `A` command:
     * measured in this page, the equivalent arc path painted 307 px of stroke
     * where the circle paints 2364, so the arc spelling is not reliable here.
     * Circumference 2 * pi * 5.42 = 34.05; the dash covers 31.78 (336deg) and
     * the offset 8.23 places that dash from 273deg clockwise, leaving the 2.27
     * unit (24deg) gap at the top.
     */
    function Glyph() {
      return React.createElement(
        'svg',
        {
          className: 'dshRestartGlyph',
          viewBox: '0 0 12 12',
          'aria-hidden': true,
          focusable: false,
        },
        React.createElement('circle', {
          cx: 6,
          cy: 6.06,
          r: 5.42,
          'stroke-dasharray': '31.78 2.27',
          'stroke-dashoffset': '8.23',
        }),
        React.createElement('path', { d: 'M0.54 1H3.56V4.02' }),
      );
    }

    /**
     * The confirm dialog. Escape and a click on the scrim cancel it; the
     * primary action is focused on open, so Enter confirms.
     *
     * @param props - `t` from the registered locale namespace, plus the two
     *   decisions the dialog can hand back.
     * @returns the dialog element.
     */
    function RestartConfirmDialog({ t, onCancel, onConfirm }) {
      const confirmRef = React.useRef(null);

      React.useEffect(() => {
        confirmRef.current?.focus();
      }, []);

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [onCancel]);

      return React.createElement(
        'div',
        {
          className: 'dshRestartScrim',
          'data-dsh-restart-dialog': '',
          role: 'presentation',
          // A press that starts on the scrim itself cancels; one that starts
          // inside the card keeps its own meaning.
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            className: 'dshRestartDialog',
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-restart-dialog-title',
            'aria-describedby': 'dsh-restart-dialog-body',
          },
          React.createElement(
            'p',
            { className: 'dshRestartDialogTitle', id: 'dsh-restart-dialog-title' },
            t('confirm.title'),
          ),
          React.createElement(
            'p',
            { className: 'dshRestartDialogBody', id: 'dsh-restart-dialog-body' },
            t('confirm.body'),
          ),
          React.createElement(
            'div',
            { className: 'dshRestartDialogActions' },
            React.createElement(
              'button',
              { type: 'button', className: 'dshRestartDialogButton', onClick: onCancel },
              t('confirm.cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshRestartDialogButton dshRestartDialogPrimary',
                ref: confirmRef,
                onClick: onConfirm,
              },
              t('confirm.ok'),
            ),
          ),
        ),
      );
    }

    /**
     * @param props - Slot props; `t` comes from the registered locale namespace.
     * @returns the caption-row button and its confirm dialog, or null where
     *   there is no caption row.
     */
    function RestartCaptionButton({ t }) {
      const [phase, setPhase] = React.useState('idle');
      const [reason, setReason] = React.useState(null);
      const [confirming, setConfirming] = React.useState(false);
      const [inset, setInset] = React.useState(() => (typeof window === 'undefined' ? null : measuredInset()));
      const busy = phase !== 'idle' && phase !== 'failed';

      React.useEffect(() => {
        const sync = () => setInset(measuredInset());
        sync();
        window.addEventListener('resize', sync);
        return () => window.removeEventListener('resize', sync);
      }, []);

      React.useEffect(() => {
        if (!document.documentElement.hasAttribute('data-windows-titlebar')) return undefined;
        void (async () => {
          // One diagnostic line so the geometry this window actually produced
          // can be checked from outside the page. Nothing about the session.
          const button = document.querySelector('[data-dsh-restart-button]');
          const insetProbe = document.createElement('div');
          insetProbe.style.cssText = 'position:fixed;left:-1000px;top:0;width:env(titlebar-area-width,0px);height:1px';
          document.body.append(insetProbe);
          const overlay = navigator.windowControlsOverlay;
          const rect = overlay && overlay.visible ? overlay.getTitlebarAreaRect() : null;
          const layer = document.querySelector('[data-shell-overlay]');
          const box = button === null ? null : button.getBoundingClientRect();
          const style = button === null ? null : getComputedStyle(button);
          const glyph = button === null ? null : button.querySelector('.dshRestartGlyph');
          const glyphBox = glyph === null ? null : glyph.getBoundingClientRect();
          const glyphStyle = glyph === null ? null : getComputedStyle(glyph);
          const payload = {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            windowsTitlebar: document.documentElement.hasAttribute('data-windows-titlebar'),
            titlebarHeight: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height').trim(),
            overlayLayer: layer === null ? null : layer.childElementCount,
            controlsOverlay: overlay ? overlay.visible === true : false,
            titlebarAreaRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            titlebarAreaWidthProbe: getComputedStyle(insetProbe).width,
            measuredInset: measuredInset(),
            button: box === null ? null : {
              x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
              right: style.right, color: style.color, display: style.display, visibility: style.visibility,
            },
            atButtonCentre: box === null ? null : String(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.className ?? null),
            glyph: glyphBox === null ? null : {
              width: Math.round(glyphBox.width * 100) / 100,
              height: Math.round(glyphBox.height * 100) / 100,
              strokeWidth: glyphStyle.strokeWidth,
            },
          };
          insetProbe.remove();
          // Rasterize the glyph itself once and report the painted pixel count
          // plus the alpha at two stroke-centreline points of its ring: 300deg
          // must be painted, 261deg must sit inside the gap. A glyph that has
          // gone invisible, or lost its gap, shows up here immediately.
          const raster = glyph === null ? null : await rasterInk(glyphMarkup(glyph, 96), 96, [[70, 11], [41, 6]]);
          void fetch('/dsh-restart/diagnostic', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...payload,
              glyphInk: raster === null ? null : raster.ink,
              glyphRingAlpha: raster === null ? null : raster.alphas[0],
              glyphGapAlpha: raster === null ? null : raster.alphas[1],
            }),
          }).catch(() => undefined);
        })();
        return undefined;
      }, []);

      /** Opens the confirm dialog. The restart itself waits for its answer. */
      const ask = React.useCallback(() => {
        if (busy) return;
        setConfirming(true);
      }, [busy]);

      const dismiss = React.useCallback(() => setConfirming(false), []);

      const restart = React.useCallback(async () => {
        if (busy) return;
        setPhase('working');
        setReason(null);
        let body = {};
        try {
          const response = await fetch('/dsh-restart/restart', { method: 'POST' });
          body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`);
        } catch (error) {
          setPhase('failed');
          setReason(error instanceof Error ? error.message : String(error));
          window.setTimeout(() => setPhase('idle'), 5000);
          return;
        }
        setPhase(body.mode === 'app' ? 'closing' : 'waiting');
        // The Host leaves with the press. In app mode the whole window goes
        // away with it; should the app kill turn out to be impossible, the
        // helper restarts only the Host, and this loop then sees the server
        // come back and reloads the page into the fresh composition.
        const deadline = Date.now() + 180000;
        for (;;) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          try {
            const probe = await fetch('/dsh-restart/status', { cache: 'no-store' });
            if (probe.ok) break;
          } catch {
            /* still down */
          }
          if (Date.now() > deadline) {
            setPhase('failed');
            setReason(t('state.waiting'));
            window.setTimeout(() => setPhase('idle'), 5000);
            return;
          }
        }
        window.location.reload();
      }, [busy, t]);

      const confirm = React.useCallback(() => {
        setConfirming(false);
        void restart();
      }, [restart]);

      if (typeof document === 'undefined') return null;
      if (!document.documentElement.hasAttribute('data-windows-titlebar')) return null;

      const label = phase === 'failed'
        ? `${t('state.failed')}${reason ?? ''}`
        : phase === 'idle' ? t('action.restart') : t(`state.${phase}`);

      const button = React.createElement(
        'button',
        {
          type: 'button',
          'data-dsh-restart-button': '',
          className: 'dshRestartButton',
          ...(inset === null ? {} : { style: { right: `${String(inset)}px` } }),
          title: phase === 'idle' ? t('action.restart') : label,
          'aria-label': phase === 'idle' ? t('action.restart') : label,
          'aria-haspopup': 'dialog',
          'aria-expanded': confirming ? 'true' : undefined,
          'aria-busy': busy ? 'true' : undefined,
          'data-phase': phase,
          ...(busy ? { 'data-busy': '' } : {}),
          onClick: ask,
        },
        React.createElement(Glyph, null),
      );

      // Out of the slot's layer and onto the body — see the header note. The
      // React tree stays where the slot put it; the DOM node that paints, and
      // that receives the click, is a child of `document.body`.
      return ReactDOM.createPortal(
        React.createElement(
          React.Fragment,
          null,
          button,
          confirming
            ? React.createElement(RestartConfirmDialog, { t, onCancel: dismiss, onConfirm: confirm })
            : null,
        ),
        document.body ?? document.documentElement,
      );
    }

    /** Installs this plugin's stylesheet once; returns its removal. */
    function installStyle() {
      let tag = document.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`);
      if (tag === null) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-restart-button';
        tag.dataset.pluginCss = STYLE_TAG;
        tag.textContent = CSS;
        document.head.append(tag);
      }
      return () => {
        tag.remove();
      };
    }

    /**
     * The distance from the right window edge to the first native caption
     * button, as this window actually lays it out.
     *
     * Chromium publishes the titlebar area it leaves to the page through the
     * Window Controls Overlay API; everything right of that area is the native
     * minimize / maximize / close group. A `--dsh-restart-caption-inset` on
     * `:root` is the user's own answer and wins. `null` means "use the
     * stylesheet's 138px".
     * @returns the inset in CSS pixels, or null.
     */
    function measuredInset() {
      const override = getComputedStyle(document.documentElement)
        .getPropertyValue('--dsh-restart-caption-inset').trim();
      if (override !== '') return null;
      try {
        const overlay = navigator.windowControlsOverlay;
        if (!overlay || overlay.visible !== true) return null;
        const rect = overlay.getTitlebarAreaRect();
        if (!rect || !(rect.width > 0)) return null;
        const inset = Math.round(window.innerWidth - (rect.x + rect.width));
        return inset > 0 && inset < 400 ? inset : null;
      } catch {
        return null;
      }
    }

    /**
     * Rasterize one SVG document through the browser's own renderer, so "is
     * this stroke actually visible" is measured rather than assumed.
     * @param markup - A complete standalone SVG document.
     * @param size - Square raster size in pixels.
     * @param points - Raster pixel coordinates to sample alpha at.
     * @returns `{ ink, alphas }`, or null when rasterizing failed.
     */
    async function rasterInk(markup, size = 96, points = []) {
      try {
        const url = `data:image/svg+xml;base64,${window.btoa(unescape(encodeURIComponent(markup)))}`;
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('glyph rasterization failed'));
          image.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (context === null) return null;
        context.drawImage(image, 0, 0, size, size);
        const { data } = context.getImageData(0, 0, size, size);
        let ink = 0;
        for (let index = 3; index < data.length; index += 4) if (data[index] > 40) ink += 1;
        const alphas = points.map(([x, y]) => data[(y * size + x) * 4 + 3]);
        return { ink, alphas };
      } catch {
        return null;
      }
    }

    /** The glyph's own markup with its presentation inline, for rasterizing. */
    function glyphMarkup(svg, size) {
      const clone = svg.cloneNode(true);
      clone.setAttribute('width', String(size));
      clone.setAttribute('height', String(size));
      clone.setAttribute('fill', 'none');
      clone.setAttribute('stroke', '#000');
      clone.setAttribute('stroke-width', '1');
      clone.setAttribute('stroke-linecap', 'butt');
      clone.setAttribute('stroke-linejoin', 'miter');
      return new XMLSerializer().serializeToString(clone);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-restart-button: dictionaries');
        ctx.effect(() => installStyle(), 'dsh-restart-button: stylesheet');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-restart-button',
          order: 30,
          locale: NS,
        }, RestartCaptionButton));
      },
    };
  },
});
