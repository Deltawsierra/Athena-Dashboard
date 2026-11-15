"use client"

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { drawsTargetText } from "@/lib/hiddenChars"

// Its primitives draw the text they are handed past this app's JSX runtime: guarded where it is handed over (lib/hiddenChars.ts).
drawsTargetText(CollapsiblePrimitive)

const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger

const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
