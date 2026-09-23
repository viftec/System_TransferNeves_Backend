-- Seed test users (admin + motorista)
-- Password hash for 'Transfer@123' (PBKDF2): 54d997255f745ab7977639eefbf08400:7e46e97eca7d4c4a577aca250fe55035689f914eae6e8cb7ce40e9b868ec0939

DELETE FROM users WHERE email IN ('teste_ad@gmail.com', 'teste_mt@gmail.com');
DELETE FROM drivers WHERE cpf = '00011122233';

-- Admin
INSERT INTO users (id, email, password_hash, name, role, phone, company, active, email_verified)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'teste_ad@gmail.com',
  '54d997255f745ab7977639eefbf08400:7e46e97eca7d4c4a577aca250fe55035689f914eae6e8cb7ce40e9b868ec0939',
  'Administrador Teste',
  'admin',
  '11999999999',
  'Transfer Neves - VIFTEC',
  1,
  1
);

-- Motorista user
INSERT INTO users (id, email, password_hash, name, role, phone, company, active, email_verified)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000002',
  'teste_mt@gmail.com',
  '54d997255f745ab7977639eefbf08400:7e46e97eca7d4c4a577aca250fe55035689f914eae6e8cb7ce40e9b868ec0939',
  'Motorista Teste',
  'driver',
  '11988888888',
  'Transfer Neves - VIFTEC',
  1,
  1
);

-- Motorista profile
INSERT INTO drivers (id, user_id, cpf, cnh, cnh_expiry, street, status, document_verified, rating, total_rides)
VALUES (
  'cccccccc-0000-0000-0000-000000000003',
  'bbbbbbbb-0000-0000-0000-000000000002',
  '00011122233',
  '99988877766',
  '2030-12-31',
  'Rua de Teste, 123',
  'approved',
  1,
  5.0,
  0
);
