-- Real lecturer roster for Ruang Dosen 4. Idempotent -- safe to re-run any
-- time (e.g. to update a photo): dosen4.upsert_lecturer() matches by
-- normalized name (text before the first comma, case/punctuation-insensitive)
-- and either updates an existing profile's display data or creates a new
-- unclaimed one, without ever touching id/auth_user_id/devices/presence.
--
-- Photos are hotlinked directly from JTI's own public staff directory
-- (https://jti.polinema.ac.id/tenaga-pengajar/) -- same institution, public
-- official photos, no separate hosting needed.
--
-- Once each person signs in with their @polinema.ac.id Google account, the
-- dosen4.handle_new_user() trigger claims the matching row automatically by
-- comparing their Google display name against these full_name values (see
-- schema.sql's "Identity linking by name match" section) -- no manual step
-- needed after this seed runs.

select dosen4.upsert_lecturer(
  'Agung Nugroho Pramudhita, S.T., M.T.',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/pak-agung.jpg'
);

select dosen4.upsert_lecturer(
  'Astrifidha Rahma Amalia, S.Pd., M.Pd.',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/mbak-astri.jpg'
);

select dosen4.upsert_lecturer(
  'Dhebys Suryani, S.Kom., MT',
  'https://jti.polinema.ac.id/wp-content/uploads/2025/07/Dhebys-Suryani.jpg'
);

select dosen4.upsert_lecturer(
  'Dian Hanifudin Subhi, S.Kom., M.Kom.',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/pak-dian-subhi.jpg'
);

select dosen4.upsert_lecturer(
  'Irsyad Arif Mashudi, S.Kom., M.Kom',
  'https://jti.polinema.ac.id/wp-content/uploads/2025/07/Irsyad-Arif-Mashudi.jpg'
);

select dosen4.upsert_lecturer(
  'Luqman Affandi, S.Kom., MMSI',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/pak-luqman.jpg'
);

select dosen4.upsert_lecturer(
  'Sofyan Noor Arief, S.ST., M.Kom.',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/pak-sofyan.jpg'
);

select dosen4.upsert_lecturer(
  'Adevian Fairuz Pratama, S.S.T, M.Eng.',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/bu-ade.jpg'
);

select dosen4.upsert_lecturer(
  'Farida Ulfa, S.Pd., M.Pd.',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/bu-farida.jpg'
);

select dosen4.upsert_lecturer(
  'Endah Septa Sintiya, S.Pd., M.Kom',
  'https://jti.polinema.ac.id/wp-content/uploads/2026/02/bu-endah.jpg'
);
