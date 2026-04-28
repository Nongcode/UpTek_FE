"use client";

import React, { CSSProperties, useEffect, useMemo, useState } from "react";

interface SmartImageProps {
  src?: string | null;
  fallbackSrc?: string | null;
  alt: string;
  className?: string;
  style?: CSSProperties;
}

export default function SmartImage({ src, fallbackSrc, alt, className, style }: SmartImageProps) {
  const sources = useMemo(
    () => Array.from(new Set([src, fallbackSrc].filter((value): value is string => Boolean(value && value.trim())))),
    [src, fallbackSrc],
  );
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sources]);

  const currentSrc = sources[sourceIndex];

  if (!currentSrc) {
    return (
      <div
        className={className}
        role="img"
        aria-label={alt}
        style={{
          ...style,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-hover)",
          color: "var(--text-secondary)",
        }}
      >
        No image
      </div>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={className}
      style={style}
      onError={() => {
        setSourceIndex((index) => Math.min(index + 1, sources.length));
      }}
    />
  );
}
