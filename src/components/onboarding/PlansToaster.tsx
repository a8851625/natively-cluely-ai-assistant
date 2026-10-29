// src/components/onboarding/PlansToaster.tsx
//
// The Natively Plans card: the first card after getting started (welcome →
// tour → permissions), for someone not yet on a plan. A startup paywall: the
// four plans side by side, a "Choose" per plan, and a quiet "Continue for free".
//
// Liquid glass: the card is clear glass over a lightly dimmed launcher, lit by
// bright rims (top edge brightest) and a soft sheen across its upper half.
// Each plan is a glass frame holding an inset well (4 px in, 17 → 13 px
// radii); the recommended one is the brightest glass in dark and the darkest
// in light, so it leads in both themes.
//
// ONE backdrop-filter, on the card. The frames, wells and buttons are only
// translucent fills and rims, so the blur is paid once however many plans
// there are (the launcher renderer has OOM'd on stacked backdrop-filters).
//
// Plans, prices and checkout links are the Plans page's own
// (NativelyApiSettings PLANS), never a second copy. Presentational: the
// onboarding orchestrator decides when it opens (OrchestratedToasterHost) and
// the card ledger decides when it may return.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { GenieModal } from '../ui/GenieModal';
import { PLANS } from '../settings/NativelyApiSettings';
import { useT } from '../../i18n';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif';

const GLASS = 'blur(28px) saturate(200%)';

const DARK = {
  backdrop: 'rgba(0,0,0,0.42)',
  card:     'rgba(22,22,26,0.32)',
  rim:      'inset 0 1px 0 rgba(255,255,255,0.50), inset 0 -1px 0 rgba(255,255,255,0.10), inset 0 0 0 1px rgba(255,255,255,0.14)',
  shadow:   '0 40px 90px -30px rgba(0,0,0,0.85)',
  sheen:    'rgba(255,255,255,0.11)',
  strong:   '#FFFFFF',
  body:     'rgba(255,255,255,0.74)',
  quiet:    'rgba(255,255,255,0.66)',
  pill:     { bg: 'rgba(255,255,255,0.88)', ink: '#0B1020' },
  plan: {
    other: {
      frame: 'rgba(255,255,255,0.06)',
      frameRim: 'inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(255,255,255,0.10)',
      band: '#FFFFFF', tag: 'rgba(255,255,255,0.66)',
      well: 'rgba(0,0,0,0.26)', wellRim: 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 0 0 1px rgba(255,255,255,0.06)', wellInk: '#FFFFFF',
      dim: 'rgba(255,255,255,0.62)', feature: 'rgba(255,255,255,0.86)',
      btn: 'rgba(255,255,255,0.10)', btnOn: 'rgba(255,255,255,0.18)', btnInk: '#FFFFFF',
      btnRim: 'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 0 0 1px rgba(255,255,255,0.12)',
    },
    rec: {
      frame: 'rgba(255,255,255,0.17)',
      frameRim: 'inset 0 1px 0 rgba(255,255,255,0.65), inset 0 -1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.28), 0 22px 50px -22px rgba(0,0,0,0.9)',
      band: '#FFFFFF', tag: 'rgba(255,255,255,0.70)',
      well: 'rgba(0,0,0,0.26)', wellRim: 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 0 0 1px rgba(255,255,255,0.06)', wellInk: '#FFFFFF',
      dim: 'rgba(255,255,255,0.62)', feature: 'rgba(255,255,255,0.86)',
      btn: '#FFFFFF', btnOn: '#E9EAEE', btnInk: '#0B1020',
      btnRim: '0 8px 20px -10px rgba(255,255,255,0.45)',
    },
  },
  error: '#FCA5A5',
};

const LIGHT: typeof DARK = {
  backdrop: 'rgba(10,10,18,0.10)',
  card:     'rgba(255,255,255,0.30)',
  rim:      'inset 0 1px 0 rgba(255,255,255,1), inset 0 -1px 0 rgba(255,255,255,0.5), inset 0 0 0 1px rgba(255,255,255,0.7), 0 0 0 1px rgba(11,16,32,0.06)',
  shadow:   '0 30px 70px -28px rgba(16,24,40,0.45)',
  sheen:    'rgba(255,255,255,0.40)',
  strong:   '#0B1020',
  body:     'rgba(11,16,32,0.74)',
  quiet:    'rgba(11,16,32,0.66)',
  pill:     { bg: 'rgba(255,255,255,0.20)', ink: '#FFFFFF' },
  plan: {
    other: {
      frame: 'rgba(255,255,255,0.34)',
      frameRim: 'inset 0 1px 0 rgba(255,255,255,1), inset 0 -1px 0 rgba(255,255,255,0.5), inset 0 0 0 1px rgba(255,255,255,0.65)',
      band: '#0B1020', tag: 'rgba(11,16,32,0.68)',
      well: 'rgba(255,255,255,0.62)', wellRim: 'inset 0 1px 0 rgba(255,255,255,1), inset 0 0 0 1px rgba(255,255,255,0.5)', wellInk: '#0B1020',
      dim: 'rgba(11,16,32,0.62)', feature: 'rgba(11,16,32,0.84)',
      btn: 'rgba(255,255,255,0.7)', btnOn: 'rgba(255,255,255,0.95)', btnInk: '#0B1020',
      btnRim: 'inset 0 1px 0 rgba(255,255,255,1), inset 0 0 0 1px rgba(11,16,32,0.10)',
    },
    rec: {
      frame: 'rgba(11,16,32,0.80)',
      frameRim: 'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 0 0 1px rgba(255,255,255,0.10), 0 22px 44px -22px rgba(16,24,40,0.55)',
      band: '#FFFFFF', tag: 'rgba(255,255,255,0.74)',
      well: 'rgba(255,255,255,0.86)', wellRim: 'inset 0 1px 0 rgba(255,255,255,1)', wellInk: '#0B1020',
      dim: 'rgba(11,16,32,0.62)', feature: 'rgba(11,16,32,0.84)',
      btn: '#0B1020', btnOn: '#1E2436', btnInk: '#FFFFFF',
      btnRim: 'none',
    },
  },
  error: '#B42318',
};

const EASE_CSS = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_FM  = [0.23, 1, 0.32, 1] as const;

const STAGGER = { hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.3 } } };
const ITEM = {
  hidden: { opacity: 0, y: 12, filter: 'blur(3px)' },
  show:   { opacity: 1, y: 0,  filter: 'blur(0px)', transition: { duration: 0.5, ease: EASE_FM as any } },
};
const ITEM_REDUCED = {
  hidden: { opacity: 0 },
  show:   { opacity: 1, transition: { duration: 0.3 } },
};

type Plan = (typeof PLANS)[number];

/** How much use each plan is for, in the words a buyer skims. */
const USAGE: Record<Plan['planKey'], string> = {
  standard: 'Now and then',
  pro:      'Every day',
  max:      'All the time',
  ultra:    'All day, recording',
};

interface Props {
  isOpen:    boolean;
  /** Why it closed, for the host's card ledger: 'acted' once a checkout opened, else nothing. */
  onDismiss: (reason?: 'acted') => void;
}

export const PlansToaster: React.FC<Props> = ({ isOpen, onDismiss }) => {
  const t = useT();
  const [opening, setOpening] = useState<Plan['id'] | null>(null);
  const [checkoutFailed, setCheckoutFailed] = useState(false);
  const [hovered, setHovered] = useState<Plan['id'] | null>(null);
  const reduced = useReducedMotion() ?? false;
  const T = useResolvedTheme() === 'light' ? LIGHT : DARK;

  // Starts closed, so the first thing the card does is pour out.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(isOpen);
  }, [isOpen]);

  // The orchestrator unmounts this the moment it hears "dismissed", so every
  // way out closes the card first (the genie) and reports from onClosed.
  const afterCloseRef = useRef<(() => void) | null>(null);
  const closeThen = useCallback((after: () => void) => {
    if (afterCloseRef.current) return;
    afterCloseRef.current = after;
    setVisible(false);
  }, []);

  // Escape, backdrop and "Continue for free" are a "later". No ✕: the
  // quiet link is the way out, as on a startup paywall.
  const handleDismiss = useCallback(() => closeThen(() => onDismiss()), [closeThen, onDismiss]);

  const handleChoose = async (plan: Plan) => {
    if (opening) return;
    setOpening(plan.id);
    setCheckoutFailed(false);
    let opened = false;
    try {
      opened = (await window.electronAPI?.openExternal?.(plan.url, { surface: 'plans_card' }))?.ok === true;
    } catch (e) {
      console.warn('[PlansToaster] openExternal failed:', e);
    }
    // Opened: the user is at checkout. Not opened: stay, say so, record nothing.
    if (opened) closeThen(() => onDismiss('acted'));
    else { setCheckoutFailed(true); setOpening(null); }
  };

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, handleDismiss]);

  useEffect(() => {
    if (!visible) setHovered(null);
  }, [visible]);

  const item = reduced ? ITEM_REDUCED : ITEM;

  return (
    <GenieModal
      open={visible}
      label="PlansToaster"
      // Glass keeps no pictures: one bakes in the launcher behind it as it was
      // then, and the next open would pour out that stale backdrop (and, after
      // a redesign, the old card). Its open pours the live card instead.
      keepPictures={false}
      zIndex={9998}
      onBackdropClick={handleDismiss}
      onClosed={() => { const after = afterCloseRef.current; afterCloseRef.current = null; after?.(); }}
      backdropStyle={{ background: T.backdrop }}
      padding={16}
      wrapStyle={{ width: '920px', maxWidth: '100%' }}
      cardStyle={{
        background: T.card,
        backdropFilter: GLASS,
        WebkitBackdropFilter: GLASS,
        boxShadow: `${T.rim}, ${T.shadow}`,
        fontFamily: FONT,
        WebkitFontSmoothing: 'antialiased',
      } as React.CSSProperties}
      cardProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-labelledby': 'plans-toast-title',
        'aria-describedby': 'plans-toast-desc',
      }}
      shadow={T.shadow}
      radius={28}
    >
      {/* Sheen: light catching the upper half of the glass. */}
      <div aria-hidden style={{
        position: 'absolute', inset: '0 0 auto 0', height: '46%', pointerEvents: 'none',
        background: `linear-gradient(180deg, ${T.sheen}, rgba(255,255,255,0))`,
      }} />

      <motion.div
        variants={STAGGER} initial={reduced ? 'hidden' : false} animate="show"
        style={{ position: 'relative', padding: '34px 32px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
      >
        <motion.div variants={item} style={{ fontSize: '12px', fontWeight: 500, letterSpacing: '-0.005em', color: T.quiet }}>
          {t('Natively Plans')}
        </motion.div>

        <motion.h2 variants={item} id="plans-toast-title" style={{
          margin: '8px 0 6px', fontSize: '32px', fontWeight: 300,
          letterSpacing: '-0.03em', lineHeight: 1.1, color: T.strong,
        }}>
          {t('Pick how much Natively you need')}
        </motion.h2>

        <motion.p variants={item} id="plans-toast-desc" style={{
          margin: '0 0 24px', fontSize: '13px', lineHeight: 1.5, letterSpacing: '-0.008em', color: T.body,
        }}>
          {t('Every plan covers AI answers, transcription and web search on one key.')}
        </motion.p>

        <motion.div variants={item} style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
          {PLANS.map(plan => {
            const rec = plan.badgeText === 'Recommended';
            const P = rec ? T.plan.rec : T.plan.other;
            const hot = hovered === plan.id;
            const busy = opening === plan.id;
            return (
              <div key={plan.id} style={{
                display: 'flex', flexDirection: 'column', minHeight: '390px', boxSizing: 'border-box',
                padding: '4px', borderRadius: '17px', background: P.frame, boxShadow: P.frameRim,
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 12px 14px', color: P.band }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                    <span style={{ fontSize: '15px', fontWeight: 600, letterSpacing: '-0.01em' }}>{plan.name}</span>
                    {rec && (
                      <span style={{
                        fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px',
                        background: T.pill.bg, color: T.pill.ink,
                      }}>
                        {t('Recommended')}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: '12px', color: P.tag }}>{USAGE[plan.planKey]}</span>
                </div>

                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '16px 14px 14px', borderRadius: '13px',
                  background: P.well, boxShadow: P.wellRim, color: P.wellInk,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: '32px', fontWeight: 300, letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums' }}>{plan.price}</span>
                    <span style={{ fontSize: '12px', color: P.dim }}>/month</span>
                  </div>

                  <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '9px', flex: 1 }}>
                    {plan.features.map(f => (
                      <li key={f} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', lineHeight: 1.4, color: P.feature }}>
                        <Check size={14} strokeWidth={2.2} aria-hidden style={{ flex: 'none', marginTop: '2px', color: P.wellInk }} />
                        {f}
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    onClick={() => handleChoose(plan)}
                    disabled={!!opening}
                    onMouseEnter={() => setHovered(plan.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={e => { if (e.currentTarget.matches(':focus-visible')) setHovered(plan.id); }}
                    onBlur={() => setHovered(null)}
                    style={{
                      marginTop: '16px', height: '40px', border: 0, borderRadius: '999px',
                      fontFamily: FONT, fontSize: '13px', fontWeight: 600, letterSpacing: '-0.01em',
                      background: hot ? P.btnOn : P.btn, color: P.btnInk, boxShadow: P.btnRim,
                      cursor: opening ? 'progress' : 'pointer',
                      opacity: opening && !busy ? 0.5 : 1,
                      outline: 'none',
                      transition: `background-color 280ms ${EASE_CSS}, opacity 200ms ${EASE_CSS}`,
                    }}
                  >
                    {busy ? 'Opening checkout' : `Choose ${plan.name}`}
                  </button>
                </div>
              </div>
            );
          })}
        </motion.div>

        {checkoutFailed && (
          <p role="alert" style={{ margin: '14px 0 0', fontSize: '12px', color: T.error }}>
            {t("Couldn't open checkout. Try again, or use Settings › Plans & Billing.")}
          </p>
        )}

        <motion.button
          variants={item}
          type="button"
          onClick={handleDismiss}
          style={{
            marginTop: '14px', minHeight: '36px', padding: '0 10px',
            background: 'none', border: 0, cursor: 'pointer', fontFamily: FONT,
            fontSize: '12.5px', fontWeight: 500, letterSpacing: '-0.006em',
            color: T.quiet,
            transition: `color 200ms ${EASE_CSS}`,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = T.strong)}
          onMouseLeave={e => (e.currentTarget.style.color = T.quiet)}
          onFocus={e => (e.currentTarget.style.color = T.strong)}
          onBlur={e => (e.currentTarget.style.color = T.quiet)}
        >
          {t('Continue for free')}
        </motion.button>
      </motion.div>
    </GenieModal>
  );
};

export default PlansToaster;
