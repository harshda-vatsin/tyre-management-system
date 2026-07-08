'use client';

import React, { useState } from 'react';
import { useAuth } from '../../components/AuthContext.jsx';
import { FLEET_WIDE_ROLES } from '../../lib/roles.js';
import NationalDashboard from '../../components/NationalDashboard.jsx';
import DepotDashboard from '../../components/DepotDashboard.jsx';

// SRS 7.1/7.2: same landing route ("/"), content adapts to role. National
// roles (Admin/NFM/Auditor) get the fleet-wide view with drill-down into any
// depot; Depot Manager/Tyre Supervisor always see their own depot's view.
export default function DashboardPage() {
  const { user } = useAuth();
  // Matches backend NATIONAL_ROLES in routes/dashboard.js exactly.
  const isNational = FLEET_WIDE_ROLES.includes(user?.role);
  const [drillDownDepotId, setDrillDownDepotId] = useState(null);

  if (!isNational) {
    return <DepotDashboard depotId={user.depot_id} />;
  }

  if (drillDownDepotId) {
    return <DepotDashboard depotId={drillDownDepotId} onBack={() => setDrillDownDepotId(null)} />;
  }

  return <NationalDashboard onDrillDown={setDrillDownDepotId} />;
}
