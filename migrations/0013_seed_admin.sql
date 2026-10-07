-- Cria a conta admin padrão solicitada antes de subir para produção
INSERT INTO users (id, email, password_hash, name, role, email_verified, active)
VALUES (
  'b0e45c7b-dc5c-4d8e-8a03-718a280f5f7f',
  'josedasneves32@yahoo.com.br',
  '0657765fee59d170198434a7fe12c019:28c73dfea9483e511047b28b2aa9afc420d8bb3b03ceb893c9c26e821b8bc765',
  'José das Neves',
  'admin',
  1,
  1
);
