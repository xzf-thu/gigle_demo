import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'ghost' | 'outline';
  size?: 'default' | 'icon' | 'icon-lg';
};

export function Button({ variant = 'default', size = 'default', className = '', type = 'button', ...props }: Props) {
  return <button type={type} className={`wb-button wb-${variant} wb-${size} ${className}`} {...props} />;
}
