import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio"
import { drawsTargetText } from "@/lib/hiddenChars"

// Its primitives draw the text they are handed past this app's JSX runtime: guarded where it is handed over (lib/hiddenChars.ts).
drawsTargetText(AspectRatioPrimitive)

const AspectRatio = AspectRatioPrimitive.Root

export { AspectRatio }
