import { useEffect, useState } from 'react';
import styles from './FilePreview.module.css';

interface Props {
  file?: File;
  url?: string;
  href?: string;
  onRemove?: () => void;
}

export default function FilePreview({ file, url, href, onRemove }: Props) {
  const [src, setSrc] = useState<string | undefined>(url);

  useEffect(() => {
    if (url) {
      setSrc(url);
      return;
    }
    if (!file) {
      setSrc(undefined);
      return;
    }
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      if (!cancelled) setSrc(reader.result as string);
    };
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
    };
  }, [file, url]);

  const thumb = src ? (
    <img className={styles.thumb} src={src} alt="" />
  ) : (
    <div className={styles.thumbPlaceholder} />
  );

  return (
    <div className={styles.preview}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className={styles.link}>
          {thumb}
        </a>
      ) : (
        thumb
      )}
      {onRemove && (
        <button
          className={styles.remove}
          onClick={onRemove}
          title="移除"
          aria-label="移除"
        >
          ×
        </button>
      )}
    </div>
  );
}
