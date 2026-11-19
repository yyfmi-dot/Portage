/** Copy and confirm on the button itself. */
export function copyText(button: HTMLElement, text: string) {
  void navigator.clipboard?.writeText(text).then(() => {
    const label = button.textContent;
    button.textContent = "Copied";
    button.classList.add("done");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("done");
    }, 1400);
  });
}
