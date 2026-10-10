import { useCallback, useState } from "react";

/** The toast notification at the top of the screen: shows a message for 3 seconds. */
export function useToast() {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  }, []);

  return { toastMessage, showToast };
}
