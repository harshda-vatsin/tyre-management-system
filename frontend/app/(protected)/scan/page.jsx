'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Html5Qrcode } from 'html5-qrcode';
import { AlertTriangle, CheckCircle2, RotateCcw, Search, ScanLine } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { parseQrPayload } from '../../../lib/qrPayload.js';
import PageHeader from '../../../components/PageHeader.jsx';
import TyreSelect from '../../../components/TyreSelect.jsx';

// Shared by both the QR-decode path and the manual-search fallback: given a
// resolved tyre id, fetches the authenticated Tyre Card PDF and opens it.
async function openTyreCardPdf(tyreId) {
  const token = localStorage.getItem('ebtms_token');
  const pdfRes = await fetch(`/api/tyres/${tyreId}/export-pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!pdfRes.ok) {
    const data = await pdfRes.json().catch(() => ({}));
    const err = new Error(data.error || 'Failed to fetch Tyre Card PDF');
    err.status = pdfRes.status;
    throw err;
  }
  const blob = await pdfRes.blob();
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
  const win = window.open(url, '_blank');
  if (!win) window.location.href = url;
}

export default function ScanPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [cameraFailed, setCameraFailed] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [resolvingManual, setResolvingManual] = useState(false);
  const html5QrCodeRef = useRef(null);
  const startScannerRef = useRef(() => {});

  useEffect(() => {
    const html5QrCode = new Html5Qrcode('reader');
    html5QrCodeRef.current = html5QrCode;

    async function handleScan(decodedText) {
      setError('');
      setSuccessMsg('');

      // Immediately stop camera tracks to prevent subsequent capture triggers
      try {
        if (html5QrCode.isScanning) {
          await html5QrCode.stop();
        }
      } catch (err) {
        console.error('Failed to stop camera tracks:', err);
      }

      // 1. QR Payload Validation
      const tyreNumber = parseQrPayload(decodedText);
      if (!tyreNumber) {
        setError('Invalid EBTMS tyre QR code');
        setTimeout(startScanner, 3000);
        return;
      }

      // 2. Resolve Tyre Number via Lookup API, then fetch + open the PDF
      try {
        setSuccessMsg(`Resolving tyre ${tyreNumber}...`);
        const res = await api.get(`/tyres/lookup/${tyreNumber}`);
        setSuccessMsg(`Fetching authenticated Tyre Card PDF for ${tyreNumber}...`);
        await openTyreCardPdf(res.id);
        setSuccessMsg('Tyre Card PDF resolved and loaded successfully.');
      } catch (err) {
        setSuccessMsg('');
        if (err.status === 404) {
          setError('Tyre not found');
        } else if (err.status === 403) {
          setError('Not authorized to access this tyre (depot scoped).');
        } else {
          setError(err.message || 'Error resolving tyre QR');
        }
        setTimeout(startScanner, 3000);
      }
    }

    function startScanner() {
      setError('');
      setSuccessMsg('');
      setCameraFailed(false);
      if (html5QrCodeRef.current && !html5QrCodeRef.current.isScanning) {
        html5QrCodeRef.current.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          handleScan,
          () => {} // Silent scan errors
        ).catch(err => {
          setCameraFailed(true);
          const errStr = err.toString();
          if (errStr.includes('NotAllowedError') || errStr.includes('Permission denied')) {
            setError('Camera access denied. Grant camera permission in your browser to scan, or search manually below.');
          } else if (errStr.includes('NotFoundError') || errStr.includes('no device found')) {
            setError('No camera found on this device. Search for the tyre manually below.');
          } else {
            setError('Failed to start camera: ' + err.message);
          }
        });
      }
    }

    startScannerRef.current = startScanner;
    startScanner();

    return () => {
      if (html5QrCodeRef.current) {
        if (html5QrCodeRef.current.isScanning) {
          html5QrCodeRef.current.stop().catch(err => console.error('Failed to cleanup camera tracks:', err));
        }
      }
    };
  }, [router]);

  async function handleManualSelect(tyre) {
    if (!tyre) return;
    setError('');
    setSuccessMsg('');
    setResolvingManual(true);
    try {
      setSuccessMsg(`Fetching authenticated Tyre Card PDF for ${tyre.tyre_number}...`);
      await openTyreCardPdf(tyre.id);
      setSuccessMsg('Tyre Card PDF resolved and loaded successfully.');
    } catch (err) {
      setSuccessMsg('');
      if (err.status === 403) {
        setError('Not authorized to access this tyre (depot scoped).');
      } else {
        setError(err.message || 'Error resolving tyre');
      }
    } finally {
      setResolvingManual(false);
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <PageHeader title="Scan Tyre QR Code" description="Place the tyre card QR code in front of your camera to open its digital tyre card." />

      {error && (
        <div className="status-banner error">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="status-banner success">
          <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="scanner-frame" style={{ minHeight: 300 }}>
          <div className="scanner-corner tl" />
          <div className="scanner-corner tr" />
          <div className="scanner-corner bl" />
          <div className="scanner-corner br" />
          <div id="reader" style={{ width: '100%', minHeight: 300 }}></div>
        </div>
        {cameraFailed && (
          <div style={{ padding: '1rem', textAlign: 'center' }}>
            <button className="secondary" onClick={() => startScannerRef.current()}>
              <RotateCcw size={15} /> Retry Camera
            </button>
          </div>
        )}
      </div>

      <div className="card">
        {!manualMode ? (
          <button className="secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setManualMode(true)}>
            <Search size={15} /> Search tyre manually instead
          </button>
        ) : (
          <>
            <div className="card-title-row"><h3><ScanLine size={16} style={{ verticalAlign: -3 }} /> Manual Tyre Lookup</h3></div>
            <TyreSelect label="Tyre Number" onChange={handleManualSelect} />
            {resolvingManual && <p style={{ fontSize: '0.82rem' }}>Resolving...</p>}
          </>
        )}
      </div>
    </div>
  );
}
