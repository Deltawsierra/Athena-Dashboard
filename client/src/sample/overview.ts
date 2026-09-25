/**
 * The Overview's sample figures: the fixture estate the page was first drawn
 * with, kept for prospect demos and nothing else. Not a measurement of any
 * environment. Reach it through `overviewSample()` in ./index, which refuses
 * when sample mode is off.
 */
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  FileCheck2,
  ScanLine,
  ShieldCheck,
} from "lucide-react";

import type { OverviewModel } from "@/pages/Overview";

export const OVERVIEW_SAMPLE: OverviewModel = {
  metrics: [
    { key: "systems", label: "Systems Registered", value: 42, icon: Boxes, delta: { value: "+16%", direction: "up", good: true, note: "vs. last month" } },
    { key: "scans", label: "Scans In Progress", value: 18, icon: ScanLine, delta: { value: "+6%", direction: "up", good: true, note: "vs. last month" } },
    { key: "findings", label: "Open Findings", value: 23, icon: AlertTriangle, accent: "var(--sev-high)", delta: { value: "+28%", direction: "up", good: false, note: "vs. last month" } },
    { key: "decisions", label: "Assurance Decisions", value: 31, icon: CheckCircle2, delta: { value: "+48%", direction: "up", good: true, note: "approved" } },
    { key: "readiness", label: "Compliance Readiness", value: "87%", icon: ShieldCheck, delta: { value: "+5%", direction: "up", good: true, note: "vs. last month" } },
  ],
  posture: {
    pct: 0.62,
    label: "Moderate Risk",
    summary: "Your AI program shows moderate risk. Address high-priority findings to reduce exposure and maintain momentum.",
  },
  postureFigures: [
    { value: "23", label: "Open Findings" },
    { value: "4", label: "High Severity" },
    { value: "87%", label: "Compliance Ready" },
  ],
  trend: {
    rows: [
      { m: "Jan", critical: 4, high: 6, medium: 3, low: 2 },
      { m: "Feb", critical: 5, high: 7, medium: 4, low: 3 },
      { m: "Mar", critical: 7, high: 8, medium: 5, low: 3 },
      { m: "Apr", critical: 9, high: 9, medium: 6, low: 4 },
      { m: "May", critical: 11, high: 10, medium: 6, low: 4 },
      { m: "Jun", critical: 13, high: 11, medium: 7, low: 4 },
      { m: "Jul", critical: 16, high: 11, medium: 8, low: 5 },
      { m: "Aug", critical: 18, high: 12, medium: 8, low: 5 },
      { m: "Sep", critical: 21, high: 13, medium: 9, low: 5 },
      { m: "Oct", critical: 23, high: 14, medium: 9, low: 5 },
    ],
  },
  environments: {
    rows: [
      { env: "Production", value: 11, tone: "hsl(var(--sev-critical))" },
      { env: "Staging", value: 7, tone: "hsl(var(--sev-high))" },
      { env: "Development", value: 4, tone: "hsl(var(--sev-medium))" },
      { env: "Third-party", value: 3, tone: "hsl(var(--sev-medium))" },
      { env: "R&D", value: 2, tone: "hsl(var(--sev-info))" },
    ],
  },
  coverage: {
    rows: [
      { name: "Customer Support Agent", pct: 100 },
      { name: "Fraud Detection", pct: 87 },
      { name: "Document Intelligence", pct: 71 },
      { name: "Marketing Assistant", pct: 56 },
      { name: "Internal Knowledge Copilot", pct: 43 },
      { name: "Code Review Assistant", pct: 38 },
    ],
  },
  attention: {
    rows: [
      { name: "Marketing Content Generator", note: "New high severity findings", sev: "high", ago: "2d ago" },
      { name: "HR Policy Assistant", note: "Scan overdue (7 days)", sev: "medium", ago: "3d ago" },
      { name: "Finance Data Q&A", note: "Unreviewed findings", sev: "medium", ago: "4d ago" },
      { name: "Legacy Chatbot", note: "Compliance evidence missing", sev: "low", ago: "5d ago" },
      { name: "Product Research Agent", note: "Third-party data sharing risk", sev: "low", ago: "6d ago" },
    ],
  },
  activity: {
    rows: [
      { icon: CheckCircle2, tone: "text-emerald-400", text: "Scan completed: Customer Support Agent", meta: "No new findings", ago: "2h ago" },
      { icon: AlertTriangle, tone: "text-sev-high", text: "New high severity finding", meta: "Marketing Content Generator", ago: "4h ago" },
      { icon: ShieldCheck, tone: "text-emerald-400", text: "Deployment approved", meta: "Fraud Detection", ago: "6h ago" },
      { icon: FileCheck2, tone: "text-primary", text: "Evidence uploaded", meta: "Internal Knowledge Copilot", ago: "1d ago" },
      { icon: ScanLine, tone: "text-primary", text: "Scan started", meta: "HR Policy Assistant", ago: "1d ago" },
    ],
  },
  reviews: {
    rows: [
      { date: "Oct 15", name: "Customer Support Agent", findings: 3, sev: "high" },
      { date: "Oct 16", name: "Finance Data Q&A", findings: 5, sev: "medium" },
      { date: "Oct 17", name: "Marketing Content Generator", findings: 4, sev: "medium" },
      { date: "Oct 18", name: "Code Review Assistant", findings: 2, sev: "low" },
      { date: "Oct 20", name: "Vendor Data Extractor", findings: 3, sev: "low" },
    ],
  },
  issues: {
    rows: [
      { t: "Customer PII included in support prompts", sev: "critical" },
      { t: "Unrestricted access to CRM customer records", sev: "high" },
      { t: "Potential data retention beyond policy", sev: "high" },
      { t: "Third-party data sharing lacks contractual controls", sev: "medium" },
      { t: "Insufficient monitoring for prompt injection", sev: "medium" },
    ],
  },
};
