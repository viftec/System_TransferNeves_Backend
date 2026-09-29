import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ─────────────────────────────────────────────
// USERS (admins e motoristas)
// ─────────────────────────────────────────────
export const users = sqliteTable('users', {
  id:               text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  email:            text('email').notNull().unique(),
  passwordHash:     text('password_hash').notNull(),
  name:             text('name').notNull(),
  role:             text('role', { enum: ['admin', 'driver'] }).notNull(),
  phone:            text('phone'),
  company:          text('company').default('Transfer Neves - VIFTEC'),
  active:           integer('active', { mode: 'boolean' }).notNull().default(true),
  emailVerified:    integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  verificationToken:text('verification_token'),
  resetToken:       text('reset_token'),
  resetTokenCreatedAt: text('reset_token_created_at'),
  createdAt:        text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:        text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// ─────────────────────────────────────────────
// DRIVERS (perfil completo do motorista)
// ─────────────────────────────────────────────
export const drivers = sqliteTable('drivers', {
  id:               text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:           text('user_id').notNull().references(() => users.id),
  cpf:              text('cpf').notNull().unique(),
  cnh:              text('cnh').notNull(),
  cnhExpiry:        text('cnh_expiry'),
  street:           text('street'),
  number:           text('number'),
  complement:       text('complement'),
  neighborhood:     text('neighborhood'),
  city:             text('city'),
  state:            text('state'),
  cep:              text('cep'),
  cities:           text('cities'), // JSON array of cities the driver serves
  status:           text('status', { enum: ['pending', 'approved', 'online', 'offline', 'suspended'] }).notNull().default('pending'),
  documentVerified: integer('document_verified', { mode: 'boolean' }).notNull().default(false),
  rating:           real('rating').default(0),
  totalRides:       integer('total_rides').notNull().default(0),
  avatarKey:        text('avatar_key'),  // chave no R2
  createdAt:        text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:        text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// ─────────────────────────────────────────────
// VEHICLES
// ─────────────────────────────────────────────
export const vehicles = sqliteTable('vehicles', {
  id:       text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  driverId: text('driver_id').notNull().references(() => drivers.id),
  type:     text('type', { enum: ['sedan', 'suv', 'hatch', 'van', 'caminhonete', 'caminhao'] }).notNull(),
  model:    text('model').notNull(),
  plate:    text('plate').notNull().unique(),
  year:     integer('year'),
  color:    text('color'),
  active:   integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────
export const clients = sqliteTable('clients', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name:           text('name').notNull(),
  fantasyName:    text('fantasy_name'),
  type:           text('type', { enum: ['pf', 'pj'] }).notNull(),
  cpfCnpj:        text('cpf_cnpj').notNull().unique(),
  phone:          text('phone').notNull(),
  whatsapp:       text('whatsapp'),
  email:          text('email'),
  secondaryPhone: text('secondary_phone'),
  street:         text('street'),
  number:         text('number'),
  complement:     text('complement'),
  neighborhood:   text('neighborhood'),
  city:           text('city'),
  state:          text('state'),
  cep:            text('cep'),
  isRecurring:    integer('is_recurring', { mode: 'boolean' }).notNull().default(false),
  status:         text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),
  notes:          text('notes'),
  totalRides:     integer('total_rides').notNull().default(0),
  lastRideDate:   text('last_ride_date'),
  createdAt:      text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:      text('updated_at').notNull().default(sql`(datetime('now'))`),
  deletedAt:      text('deleted_at'),
})

// ─────────────────────────────────────────────
// RIDES (corridas)
// ─────────────────────────────────────────────
export const rides = sqliteTable('rides', {
  id:               text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  code:             text('code').notNull().unique(),
  clientId:         text('client_id').references(() => clients.id),
  clientName:       text('client_name'), // Avulso
  driverId:         text('driver_id').references(() => drivers.id),
  vehicleId:        text('vehicle_id').references(() => vehicles.id),
  type:             text('type', { enum: ['passageiros', 'carga'] }).notNull(),
  passengerCount:   integer('passenger_count'),
  hasLuggage:       integer('has_luggage', { mode: 'boolean' }).notNull().default(false),
  luggageDescription: text('luggage_description'),
  cargoType:        text('cargo_type'),
  cargoWeightKg:    real('cargo_weight_kg'),
  cargoWidth:       real('cargo_width'),
  cargoLength:      real('cargo_length'),
  cargoHeight:      real('cargo_height'),
  cargoFragile:     integer('cargo_fragile', { mode: 'boolean' }).notNull().default(false),
  allowedVehicleTypes: text('allowed_vehicle_types'), // Array de tipos: ["sedan","suv"] em JSON
  // Origem
  originStreet:     text('origin_street'),
  originNumber:     text('origin_number'),
  originComplement: text('origin_complement'),
  originNeighborhood: text('origin_neighborhood'),
  originCity:       text('origin_city').notNull(),
  originState:      text('origin_state'),
  originCep:        text('origin_cep'),
  // Destino
  destStreet:       text('dest_street'),
  destNumber:       text('dest_number'),
  destComplement:   text('dest_complement'),
  destNeighborhood: text('dest_neighborhood'),
  destCity:         text('dest_city').notNull(),
  destState:        text('dest_state'),
  destCep:          text('dest_cep'),
  // Dados operacionais
  city:             text('city'),
  scheduledDate:    text('scheduled_date').notNull(),
  scheduledTime:    text('scheduled_time').notNull(),
  value:            real('value').notNull(),
  paymentMethod:    text('payment_method', { enum: ['card', 'transfer', 'cash', 'billed'] }).notNull().default('billed'),
  status:           text('status').notNull().default('disponivel'),
  notes:            text('notes'),
  isRecurring:      integer('is_recurring', { mode: 'boolean' }).notNull().default(false),
  requiresPhoto:    integer('requires_photo', { mode: 'boolean' }).notNull().default(false),
  isUrgent:         integer('is_urgent', { mode: 'boolean' }).notNull().default(false),
  allowCancellation: integer('allow_cancellation', { mode: 'boolean' }).notNull().default(true),
  showValueToDriver: integer('show_value_to_driver', { mode: 'boolean' }).notNull().default(true),
  proofKey:         text('proof_key'),  // comprovante no R2
  createdAt:        text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:        text('updated_at').notNull().default(sql`(datetime('now'))`),
  deletedAt:        text('deleted_at'),
})

// ─────────────────────────────────────────────
// RIDE EVENTS (timeline de cada corrida)
// ─────────────────────────────────────────────
export const rideEvents = sqliteTable('ride_events', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  rideId:      text('ride_id').notNull().references(() => rides.id),
  event:       text('event').notNull(),
  description: text('description').notNull(),
  userId:      text('user_id').references(() => users.id),
  createdAt:   text('created_at').notNull().default(sql`(datetime('now'))`),
})

// ─────────────────────────────────────────────
// RATE LIMITS (prevenir abuso em login/registro)
// ─────────────────────────────────────────────
export const rateLimits = sqliteTable('rate_limits', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  identifier:  text('identifier').notNull(), // IP ou email
  endpoint:    text('endpoint').notNull(), // 'login', 'register', etc
  attempts:    integer('attempts').notNull().default(1),
  lastAttempt: text('last_attempt').notNull().default(sql`(datetime('now'))`),
  blockedUntil: text('blocked_until'), // timestamp até quando está bloqueado
  createdAt:   text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:   text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// ─────────────────────────────────────────────
// UPLOADS (referências de arquivos no R2)
// ─────────────────────────────────────────────
export const uploads = sqliteTable('uploads', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  r2Key:       text('r2_key').notNull().unique(),
  entityType:  text('entity_type').notNull(),  // 'ride_proof', 'driver_doc', 'driver_avatar'
  entityId:    text('entity_id').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes:   integer('size_bytes'),
  uploadedBy:  text('uploaded_by').references(() => users.id),
  createdAt:   text('created_at').notNull().default(sql`(datetime('now'))`),
})
