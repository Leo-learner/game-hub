import { Type as T, type TSchema } from '@sinclair/typebox';

const text = (maxLength=200) => T.String({ maxLength });
export const Identifier = T.String({ minLength: 1, maxLength: 100 });
export const Slug = T.String({ pattern:'^[a-z0-9]+(?:-[a-z0-9]+)*$', minLength:1, maxLength:64 });
export const Slot = T.String({ pattern:'^[A-Za-z0-9_-]{1,32}$' });
export const Revision = T.Integer({ minimum:0, maximum:Number.MAX_SAFE_INTEGER-1 });
export const User = T.Object({ id:Identifier, username:text(20), displayName:text(24), role:T.Union([T.Literal('player'),T.Literal('admin')]), createdAt:T.String() }, { $id:'User' });
export const ManifestSchema = T.Object({
  manifestVersion: T.Literal(1), cover:T.Optional(T.String({minLength:1,maxLength:300})),
  saveSchemaVersion:T.Integer({minimum:1,maximum:2147483647}),
  saveSlots:T.Integer({minimum:1,maximum:100}),
}, {$id:'GameManifest', additionalProperties:false});
export const Game = T.Object({
  id:Identifier, slug:Slug, title:text(100), description:text(5000), tags:T.Array(text(32)), sortOrder:T.Integer(),
  published:T.Boolean(), currentReleaseId:T.Union([Identifier,T.Null()]),
  coverUrl:T.Union([T.String(),T.Null()]), launchUrl:T.Union([T.String(),T.Null()]),
  saveCapabilities:T.Object({ maxSlots:T.Integer(), maxBytes:T.Integer(), schemaVersion:T.Integer() }),
  createdAt:T.String(), updatedAt:T.String(),
}, {$id:'Game'});
export const Release = T.Object({
  id:Identifier, gameId:Identifier, sha256:T.String(), archiveBytes:T.Integer(), manifest:T.Ref(ManifestSchema),
  fileCount:T.Integer(), createdAt:T.String(), publishedAt:T.Union([T.String(),T.Null()]),
}, {$id:'Release'});
export const SaveMeta = T.Object({
  slot:Slot, schemaVersion:T.Integer(), revision:Revision, updatedAt:T.String(), sizeBytes:T.Integer(),
}, {$id:'SaveMeta'});
export const Save = T.Composite([SaveMeta, T.Object({data:T.Record(T.String(),T.Unknown())})], {$id:'Save'});
export const SaveSummary = T.Composite([SaveMeta,T.Object({gameId:Identifier,slug:Slug,gameTitle:T.String()})], {$id:'SaveSummary'});
export const ErrorSchema = T.Object({
  error:T.Object({code:T.String(),message:T.String(),details:T.Optional(T.Record(T.String(),T.Unknown()))}),
  requestId:T.String(),
},{$id:'ApiError'});
export const Ok = T.Object({ok:T.Literal(true)},{$id:'Ok'});
export const UserEnvelope = T.Object({user:T.Union([T.Ref(User),T.Null()])},{$id:'UserEnvelope'});
export const GamePage = T.Object({items:T.Array(T.Ref(Game)),page:T.Integer(),pageSize:T.Integer(),total:T.Integer()},{$id:'GamePage'});
export const SavePage = T.Object({items:T.Array(T.Ref(SaveSummary)),page:T.Integer(),pageSize:T.Integer(),total:T.Integer()},{$id:'SavePage'});
export const SaveWrite = T.Object({data:T.Record(T.String(),T.Unknown()),schemaVersion:T.Integer({minimum:1,maximum:2147483647}),expectedRevision:Revision},{$id:'SaveWrite',additionalProperties:false});
export const GameCreate = T.Object({
  slug:Slug, title:T.String({minLength:1,maxLength:100}), description:T.Optional(text(5000)),
  tags:T.Optional(T.Array(T.String({minLength:1,maxLength:32}),{maxItems:20,uniqueItems:true})),
  sortOrder:T.Optional(T.Integer({minimum:-1000000,maximum:1000000})),
},{$id:'GameCreate',additionalProperties:false});
export const GamePatch = T.Partial(T.Omit(GameCreate,['slug']),{$id:'GamePatch',additionalProperties:false,minProperties:1});
export const Register = T.Object({
  username:T.String({pattern:'^[A-Za-z0-9_]{3,20}$'}),password:T.String({minLength:8,maxLength:128}),
  displayName:T.Optional(T.String({minLength:1,maxLength:24})),
},{$id:'Register',additionalProperties:false});
export const Login = T.Object({username:T.String({minLength:1,maxLength:20}),password:T.String({minLength:1,maxLength:128})},{$id:'Login',additionalProperties:false});
export const schemas = [User,ManifestSchema,Game,Release,SaveMeta,Save,SaveSummary,ErrorSchema,Ok,UserEnvelope,GamePage,SavePage,SaveWrite,GameCreate,GamePatch,Register,Login];
export const paramsGame = T.Object({slug:Slug});
export const paramsSave = T.Object({slug:Slug,slot:Slot});
export const Pagination = T.Object({
  page:T.Optional(T.Integer({minimum:1,maximum:1000000,default:1})),
  pageSize:T.Optional(T.Integer({minimum:1,maximum:100,default:20})),
});
export const writeHeaders = T.Object({
  'x-gamehub-request':T.Literal('1'),
  'idempotency-key':T.Optional(T.String({minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'})),
  'x-gamehub-user':T.Optional(Identifier),
});
export const responses = (success:TSchema,status=200) => ({
  [status]:success,
  ...Object.fromEntries([400,401,403,404,409,413,415,429,500,503].map(s=>[s,T.Ref(ErrorSchema)])),
});
