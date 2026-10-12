// SF Symbols → lucide icons. One table so every view renders the same glyph
// for the same `systemName`, including project icons stored in config.json.
import type { LucideIcon, LucideProps } from "lucide-react";
import {
  AlertOctagon, AlertTriangle, AppWindow, ArrowRightLeft, ArrowUpRight, BadgeCheck, BarChart3, Bolt, Book,
  Camera, Check, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleX, Clock, ClockAlert,
  ClockPlus, Cloud, Compass, Cpu, ExternalLink, FlaskConical, Gamepad2, Globe, Hammer, Heart, Info, Layers,
  LineChart, Lock, Mail, MemoryStick, Moon, Music, Network, Package, Play, RefreshCcw, RefreshCw, RotateCcw,
  RotateCw, Search, Server, Settings, Settings2, Shield, ShieldHalf, ShoppingCart, SlidersHorizontal, Square,
  SquareArrowOutUpRight, SquareTerminal, Star, Terminal, Unplug, Wrench, X, Zap, Radio, Box, Container,
  Plus, Eraser, Hash, Timer, Hourglass, Folder, Ellipsis,
} from "lucide-react";

const table: Record<string, LucideIcon> = {
  // project icons (Project.icons)
  "shippingbox.fill": Package,
  "cube.fill": Box,
  "globe": Globe,
  "server.rack": Server,
  "bolt.fill": Zap,
  "cloud.fill": Cloud,
  "hammer.fill": Hammer,
  "flask.fill": FlaskConical,
  "cart.fill": ShoppingCart,
  "envelope.fill": Mail,
  "chart.bar.fill": BarChart3,
  "star.fill": Star,
  "heart.fill": Heart,
  "gamecontroller.fill": Gamepad2,
  "camera.fill": Camera,
  "music.note": Music,
  "book.fill": Book,
  "terminal.fill": SquareTerminal,

  // UI glyphs
  "play.fill": Play,
  "stop.fill": Square,
  "arrow.clockwise": RotateCw,
  "arrow.counterclockwise": RotateCcw,
  "arrow.triangle.2.circlepath": RefreshCw,
  "clock.arrow.2.circlepath": RefreshCcw,
  "exclamationmark.triangle.fill": AlertTriangle,
  "exclamationmark.triangle": AlertTriangle,
  "exclamationmark.octagon.fill": AlertOctagon,
  "clock.badge": Clock,
  "clock.badge.plus": ClockPlus,
  "clock.badge.exclamationmark": ClockAlert,
  "checkmark.circle.fill": CircleCheck,
  "checkmark.circle": CheckCircle2,
  "checkmark.seal.fill": BadgeCheck,
  "checkmark": Check,
  "xmark.circle.fill": CircleX,
  "xmark.circle": CircleX,
  "xmark": X,
  "info.circle.fill": Info,
  "moon.zzz": Moon,
  "gearshape": Settings,
  "gearshape.2": Settings2,
  "chevron.right": ChevronRight,
  "chevron.down": ChevronDown,
  "terminal": Terminal,
  "square.stack.3d.up": Layers,
  "slider.horizontal.3": SlidersHorizontal,
  "network": Network,
  "network.slash": Unplug,
  "memorychip": MemoryStick,
  "memorychip.fill": MemoryStick,
  "magnifyingglass": Search,
  "lock.fill": Lock,
  "wrench.and.screwdriver": Wrench,
  "shield.lefthalf.filled": ShieldHalf,
  "shield": Shield,
  "safari": Compass,
  "chart.xyaxis.line": LineChart,
  "chart.bar.xaxis": BarChart3,
  "dot.radiowaves.left.and.right": Radio,
  "bolt.horizontal.circle": Bolt,
  "arrow.up.right.square": SquareArrowOutUpRight,
  "arrow.up.right": ArrowUpRight,
  "arrow.up.forward.app": ExternalLink,
  "app.dashed": AppWindow,
  "cpu": Cpu,
  "shippingbox": Container,
  "arrow.left.arrow.right": ArrowRightLeft,
  "exclamationmark.circle": CircleAlert,
  "plus": Plus,
  "eraser": Eraser,
  "number": Hash,
  "clock": Clock,
  "timer": Timer,
  "hourglass": Hourglass,
  "folder": Folder,
  "ellipsis": Ellipsis,
};

/** Equivalent of `Image(systemName:)`. `size` is the SwiftUI font size the symbol sits in. */
export function Symbol({ name, size = 13, ...rest }: { name: string; size?: number } & Omit<LucideProps, "size">) {
  const Icon = table[name] ?? Package;
  // SF Symbols render at roughly the cap height + overshoot of their font size.
  const px = Math.round(size * 1.05);
  const filled = name.endsWith(".fill") && (name.startsWith("play") || name.startsWith("stop") || name.startsWith("star") || name.startsWith("heart"));
  return <Icon size={px} strokeWidth={size <= 10 ? 2.6 : 2} fill={filled ? "currentColor" : "none"} aria-hidden {...rest} />;
}

export const PROJECT_ICONS = [
  "shippingbox.fill", "cube.fill", "globe", "server.rack", "bolt.fill",
  "cloud.fill", "hammer.fill", "flask.fill", "cart.fill", "envelope.fill",
  "chart.bar.fill", "star.fill", "heart.fill", "gamecontroller.fill",
  "camera.fill", "music.note", "book.fill", "terminal.fill",
];
