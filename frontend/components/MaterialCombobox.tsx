"use client";

import type { ComponentProps } from "react";

import { Combobox } from "./Combobox";

const EMPTY_LABEL = "— select material —";

/** The shared combobox wearing the material catalog's wording. */
export function MaterialCombobox(props: ComponentProps<typeof Combobox>) {
  return <Combobox aria-label="Material" placeholder={EMPTY_LABEL} {...props} />;
}
