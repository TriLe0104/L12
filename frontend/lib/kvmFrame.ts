/** NVIDIA BMC webui does `window.location='/login'` inside the KVM iframe.
 *  Same-origin Next then serves L12 sign-in (and may bounce a signed-in user
 *  to Cluster). Send the iframe back under the proxy prefix. */
export function bounceKvmIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.self === window.top) return false;
    const prefix = window.sessionStorage.getItem("l12-kvm-prefix");
    if (!prefix) return false;
    const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
    window.location.replace(`${base}#/login`);
    return true;
  } catch {
    return false;
  }
}
