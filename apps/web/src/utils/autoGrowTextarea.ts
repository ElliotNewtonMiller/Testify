// Grows a textarea to fit its content instead of showing a scrollbar -- resetting height to
// "auto" first (rather than just reading scrollHeight directly) is required so the element
// can shrink back down too, not just grow: scrollHeight never reports smaller than the
// element's current height, so without the reset a field would never shrink after its
// content got shorter (e.g. deleting a wrapped line). Called from a mount-time ref callback
// (so a field that already has long content shows fully expanded immediately, not just after
// the first keystroke) and from onInput while typing.
export function autoGrowTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
