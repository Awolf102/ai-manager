import {
  Database,
  Palette,
  Cpu,
  Code,
  Server,
  FlaskConical,
  ClipboardList,
  Crown,
  Shield,
  Pencil,
  Search,
  Bot,
  BarChart3,
  Globe,
  Wrench,
  Bug,
  BookOpen,
  type LucideIcon
} from 'lucide-react'
import type { IconKey } from '../../shared/icons'

const ICONS: Record<IconKey, LucideIcon> = {
  database: Database,
  palette: Palette,
  cpu: Cpu,
  code: Code,
  server: Server,
  flask: FlaskConical,
  clipboard: ClipboardList,
  crown: Crown,
  shield: Shield,
  pencil: Pencil,
  search: Search,
  bot: Bot,
  chart: BarChart3,
  globe: Globe,
  wrench: Wrench,
  bug: Bug,
  book: BookOpen
}

export const ICON_KEYS = Object.keys(ICONS) as IconKey[]

export function iconComponent(key: string): LucideIcon {
  return ICONS[key as IconKey] ?? Bot
}
