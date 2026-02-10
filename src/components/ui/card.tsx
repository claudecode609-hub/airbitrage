import { cn } from '@/lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export function Card({ children, className, hover = false, onClick, style }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4',
        hover && 'cursor-pointer transition-all duration-200 hover:border-[var(--border-medium)] hover:bg-[var(--bg-card-hover)]',
        onClick && 'cursor-pointer',
        className,
      )}
      onClick={onClick}
      style={style}
    >
      {children}
    </div>
  );
}
