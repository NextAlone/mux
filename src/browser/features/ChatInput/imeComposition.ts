const IME_COMPOSITION_END_ENTER_SUPPRESSION_MS = 50;

type CompositionKeyEvent = Pick<KeyboardEvent, "isComposing" | "keyCode" | "which">;
type EnterKeyEvent = Pick<KeyboardEvent, "key" | "timeStamp">;

export function isInputMethodCompositionKeyEvent(event: CompositionKeyEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.which === 229;
}

export function isEnterImmediatelyAfterCompositionEnd(
  event: EnterKeyEvent,
  compositionEndTimeStamp: number | null
): boolean {
  if (event.key !== "Enter" || compositionEndTimeStamp == null) {
    return false;
  }

  const elapsedMs = event.timeStamp - compositionEndTimeStamp;
  // Some IMEs emit compositionend before the Enter keydown that confirmed the candidate.
  return elapsedMs >= 0 && elapsedMs <= IME_COMPOSITION_END_ENTER_SUPPRESSION_MS;
}
