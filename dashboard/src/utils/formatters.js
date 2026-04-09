import { formatDistanceToNow, format, formatDuration as fduration, intervalToDuration } from 'date-fns';
import { fr } from 'date-fns/locale';

export function formatDate(dateString) {
  if (!dateString) return '-';
  return format(new Date(dateString), 'dd MMM yyyy', { locale: fr });
}

export function formatRelativeTime(dateString) {
  if (!dateString) return '-';
  return formatDistanceToNow(new Date(dateString), { addSuffix: true, locale: fr });
}

export function formatScore(score) {
  if (score === undefined || score === null) return '-';
  return (score * 100).toFixed(0) + '%';
}

export function formatNumber(num) {
  if (num === undefined || num === null) return '-';
  return new Intl.NumberFormat('fr-FR').format(num);
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0s';
  const duration = intervalToDuration({ start: 0, end: seconds * 1000 });
  return fduration(duration, { locale: fr, format: ['hours', 'minutes', 'seconds'] });
}

export function truncateText(text, maxLength = 100) {
  if (!text) return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

export function cleanText(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '').trim();
}
