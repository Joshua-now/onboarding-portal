'use strict';
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

// Config from env vars (set in Railway)
const GHL_API_KEY      = process.env.GHL_API_KEY      || '';
const GHL_COMPANY_ID   = process.env.GHL_COMPANY_ID   || '';
const GHL_SNAPSHOT_ID  = process.env.GHL_SNAPSHOT_ID  || '';
const SWITCHBOARD_URL  = process.env.SWITCHBOARD_URL  || 'https://switchboard-v5-production.up.railway.app';
const SWITCHBOARD_KEY  = process.env.SWITCHBOARD_API_KEY || '';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'joshua@fluidproductions.com';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Debug GHL: look up location + snapshots
// GET /api/debug-ghl?locationId=xxx&companyId=yyy
app.get('/api/debug-ghl', async (req, res) => {
        const locationId = req.query.locationId || '';
        const companyIdOverride = req.query.companyId || GHL_COMPANY_ID;

          const result = {
                    apiKey: GHL_API_KEY ? 'set' : 'missing',
                    companyId: GHL_COMPANY_ID || '(not set)',
                    snapshotId: GHL_SNAPSHOT_ID || '(not set)',
                    companyIdUsed: companyIdOverride
          };

          if (locationId) {
                    try {
                                const locRes = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}`, {
                                              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' }
                                });
                                result.locationLookup = await locRes.json();
                    } catch (e) { result.locationError = e.message; }
          }

          if (companyIdOverride) {
                    try {
                                const snapRes = await fetch(`https://services.leadconnectorhq.com/snapshots/?companyId=${companyIdOverride}`, {
                                              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' }
                                });
                                result.snapshots = await snapRes.json();
                    } catch (e) { result.snapshotsError = e.message; }
          }

          return res.json(result);
});

// GHL Provisioning Endpoint
// Body: { name, email, phone, businessName, businessType, website, product, address? }
app.post('/api/provision', async (req, res) => {
        const { name, email, phone, businessName, businessType, website, product, address } = req.body;

           if (!name || !email || !phone || !businessName) {
                     return res.status(400).json({ error: 'Missing required fields: name, email, phone, businessName' });
           }

           console.log('[PROVISION] Starting GHL provisioning for:', businessName, email);

           try {
                     const locationPayload = {
                                 name: businessName,
                                 companyId: GHL_COMPANY_ID,
                                 address: address || '',
                                 city: '',
                                 state: '',
                                 country: 'US',
                                 postalCode: '',
                                 website: website || '',
                                 timezone: 'America/New_York',
                                 firstName: name.split(' ')[0] || name,
                                 lastName: name.split(' ').slice(1).join(' ') || '',
                                 email: email,
                                 phone: phone,
                                 businessType: businessType || 'contractor',
                     };

          console.log('[PROVISION] Step 1: Creating GHL location...');
                     const locationRes = await fetch('https://services.leadconnectorhq.com/locations/', {
                                 method: 'POST',
                                 headers: {
                                               'Authorization': `Bearer ${GHL_API_KEY}`,
                                               'Content-Type': 'application/json',
                                               'Version': '2021-07-28'
                                 },
                                 body: JSON.stringify(locationPayload)
                     });

          if (!locationRes.ok) {
                      const err = await locationRes.text();
                      console.error('[PROVISION] GHL location creation failed:', err);
                      throw new Error(`GHL location creation failed: ${locationRes.status} ${err}`);
          }

          const locationData = await locationRes.json();
                     const locationId = locationData.id || locationData.location?.id;
                     console.log('[PROVISION] Step 1 complete. Location ID:', locationId);

          console.log('[PROVISION] Step 2: Applying snapshot', GHL_SNAPSHOT_ID);
                     const snapshotRes = await fetch(
                                 `https://services.leadconnectorhq.com/locations/${locationId}/snapshots/apply`,
                           {
                                         method: 'POST',
                                         headers: {
                                                         'Authorization': `Bearer ${GHL_API_KEY}`,
                                                         'Content-Type': 'application/json',
                                                         'Version': '2021-07-28'
                                         },
                                         body: JSON.stringify({
                                                         snapshotId: GHL_SNAPSHOT_ID,
                                                         override: true
                                         })
                           }
                               );

          if (!snapshotRes.ok) {
                      const err = await snapshotRes.text();
                      console.error('[PROVISION] Snapshot apply failed:', err);
                      console.warn('[PROVISION] Continuing without snapshot...');
          } else {
                      console.log('[PROVISION] Step 2 complete. Snapshot applied.');
          }

          console.log('[PROVISION] Step 3: Creating SwitchBoard client...');
                     let switchboardClientId = null;

          if (SWITCHBOARD_KEY) {
                      const sbPayload = {
                                    name: businessName,
                                    email: email,
                                    phone: phone,
                                    ghlLocationId: locationId,
                                    product: product || 'both',
                                    status: 'active'
                      };

                       const sbRes = await fetch(`${SWITCHBOARD_URL}/api/clients`, {
                                     method: 'POST',
                                     headers: {
                                                     'Authorization': `Bearer ${SWITCHBOARD_KEY}`,
                                                     'Content-Type': 'application/json'
                                     },
                                     body: JSON.stringify(sbPayload)
                       }).catch(e => {
                                     console.warn('[PROVISION] SwitchBoard call failed:', e.message);
                                     return null;
                       });

                       if (sbRes?.ok) {
                                     const sbData = await sbRes.json();
                                     switchboardClientId = sbData.id || sbData.client?.id;
                                     console.log('[PROVISION] Step 3 complete. SwitchBoard client ID:', switchboardClientId);
                       } else {
                                     console.warn('[PROVISION] SwitchBoard client creation skipped or failed');
                       }
          } else {
                      console.warn('[PROVISION] No SWITCHBOARD_API_KEY set - skipping SwitchBoard');
          }

          const loginUrl = `https://app.gohighlevel.com/`;
                     console.log('[PROVISION] All done for', businessName);

          return res.json({
                      success: true,
                      locationId,
                      switchboardClientId,
                      loginUrl,
                      message: `GHL sub-account created and snapshot applied for ${businessName}`
          });

           } catch (err) {
                     console.error('[PROVISION] Fatal error:', err.message);
                     return res.status(500).json({
                                 error: 'Provisioning failed',
                                 detail: err.message
                     });
           }
});

// Catch-all: serve the SPA
app.get('*', (_req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
        console.log(`[ONBOARDING] Server running on port ${PORT}`);
});
