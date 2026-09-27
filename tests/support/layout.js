// Layout checks shared by the mobile and layout specs.

/**
 * Visible elements that stick out of the viewport horizontally and are not inside
 * a container that clips or scrolls them (code blocks and logs scroll on purpose).
 */
export function overflowReport(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const clipped = el => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') return true;
      }
      return false;
    };
    const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('#probes, svg, #toasts, dialog:not([open]), [hidden]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' && el.id === 'probes') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) bad.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)} of ${vw}] "${(el.textContent || '').trim().slice(0, 40)}"`);
    }
    return { viewport: vw, scrollWidth: document.scrollingElement.scrollWidth, offenders: bad.slice(0, 12) };
  });
}

/** Buttons and other tap targets smaller than `min` CSS pixels in either direction. */
export function smallTargets(page, min = 32) {
  return page.evaluate(min => {
    const out = [];
    for (const el of document.querySelectorAll('button, select, input:not([type=file]), summary, a[href]')) {
      if (el.closest('[hidden], dialog:not([open]), #probes')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const label = el.type === 'checkbox' || el.type === 'radio' ? el.closest('label') : null;
      const box = label ? label.getBoundingClientRect() : r;
      if (box.height < min || box.width < min) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return out;
  }, min);
}
