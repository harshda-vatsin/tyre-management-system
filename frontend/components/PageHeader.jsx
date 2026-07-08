'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

// Shared page header: title + description on the left, page-level actions
// (Add, Export, Transfer, etc.) on the right. `backHref` renders a back link
// above the title for detail pages.
export default function PageHeader({ title, description, actions, backHref, backLabel }) {
  return (
    <div>
      {backHref && (
        <Link href={backHref} className="page-back-link">
          <ArrowLeft size={15} /> {backLabel || 'Back'}
        </Link>
      )}
      <div className="page-header">
        <div className="page-header-title">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </div>
  );
}
