import { Query, DeleteManyResponse, UpdateManyResponse, DeepPartial, QueryService, Filter } from '@nestjs-query/core';
import lodashPick from 'lodash.pick';
import { Model, ModelCtor } from 'sequelize-typescript';
import { WhereOptions } from 'sequelize';
import { NotFoundException } from '@nestjs/common';
import { FilterQueryBuilder } from '../query';
import { RelationQueryService } from './relation-query.service';

/**
 * Base class for all query services that use a `sequelize` Model.
 *
 * @example
 *
 * ```ts
 * @QueryService(TodoItemEntity)
 * export class TodoItemService extends SequelizeQueryService<TodoItemEntity> {
 *   constructor(
 *      @InjectRepository(TodoItemEntity) repo: Repository<TodoItemEntity>,
 *   ) {
 *     super(repo);
 *   }
 * }
 * ```
 */
export class SequelizeQueryService<Entity extends Model<Entity>> extends RelationQueryService<Entity>
  implements QueryService<Entity> {
  readonly filterQueryBuilder: FilterQueryBuilder<Entity> = new FilterQueryBuilder<Entity>();

  constructor(readonly model: ModelCtor<Entity>) {
    super();
  }

  /**
   * Query for multiple entities, using a Query from `@nestjs-query/core`.
   *
   * @example
   * ```ts
   * const todoItems = await this.service.query({
   *   filter: { title: { eq: 'Foo' } },
   *   paging: { limit: 10 },
   *   sorting: [{ field: "create", direction: SortDirection.DESC }],
   * });
   * ```
   * @param query - The Query used to filter, page, and sort rows.
   */
  async query(query: Query<Entity>): Promise<Entity[]> {
    return this.model.findAll<Entity>(this.filterQueryBuilder.findOptions(query));
  }

  async count(filter: Filter<Entity>): Promise<number> {
    return this.model.count(this.filterQueryBuilder.countOptions({ filter }));
  }

  /**
   * Find an entity by it's `id`.
   *
   * @example
   * ```ts
   * const todoItem = await this.service.findById(1);
   * ```
   * @param id - The id of the record to find.
   */
  async findById(id: string | number): Promise<Entity | undefined> {
    const model = await this.model.findByPk<Entity>(id);
    if (!model) {
      return undefined;
    }
    return model;
  }

  /**
   * Gets an entity by it's `id`. If the entity is not found a rejected promise is returned.
   *
   * @example
   * ```ts
   * try {
   *   const todoItem = await this.service.getById(1);
   * } catch(e) {
   *   console.error('Unable to find entity with id = 1');
   * }
   * ```
   * @param id - The id of the record to find.
   */
  async getById(id: string | number): Promise<Entity> {
    const entity = await this.model.findByPk<Entity>(id);
    if (!entity) {
      throw new NotFoundException(`Unable to find ${this.model.name} with id: ${id}`);
    }
    return entity;
  }

  /**
   * Creates a single entity.
   *
   * @example
   * ```ts
   * const todoItem = await this.service.createOne({title: 'Todo Item', completed: false });
   * ```
   * @param record - The entity to create.
   */
  async createOne<C extends DeepPartial<Entity>>(record: C): Promise<Entity> {
    await this.ensureEntityDoesNotExist(record);
    return this.model.create<Entity>(this.getChangedValues(record));
  }

  /**
   * Create multiple entities.
   *
   * @example
   * ```ts
   * const todoItem = await this.service.createMany([
   *   {title: 'Todo Item 1', completed: false },
   *   {title: 'Todo Item 2', completed: true },
   * ]);
   * ```
   * @param records - The entities to create.
   */
  async createMany<C extends DeepPartial<Entity>>(records: C[]): Promise<Entity[]> {
    await Promise.all(records.map((r) => this.ensureEntityDoesNotExist(r)));
    return this.model.bulkCreate<Entity>(records.map((r) => this.getChangedValues(r)));
  }

  /**
   * Update an entity.
   *
   * @example
   * ```ts
   * const updatedEntity = await this.service.updateOne(1, { completed: true });
   * ```
   * @param id - The `id` of the record.
   * @param update - A `Partial` of the entity with fields to update.
   */
  async updateOne<U extends DeepPartial<Entity>>(id: number | string, update: U): Promise<Entity> {
    this.ensureIdIsNotPresent(update);
    const entity = await this.getById(id);
    return entity.update(this.getChangedValues(update));
  }

  /**
   * Update multiple entities with a `@nestjs-query/core` Filter.
   *
   * @example
   * ```ts
   * const { updatedCount } = await this.service.updateMany(
   *   { completed: true }, // the update to apply
   *   { title: { eq: 'Foo Title' } } // Filter to find records to update
   * );
   * ```
   * @param update - A `Partial` of entity with the fields to update
   * @param filter - A Filter used to find the records to update
   */
  async updateMany<U extends DeepPartial<Entity>>(update: U, filter: Filter<Entity>): Promise<UpdateManyResponse> {
    this.ensureIdIsNotPresent(update);
    const [count] = await this.model.update(
      this.getChangedValues(update),
      this.filterQueryBuilder.updateOptions({ filter }),
    );
    return { updatedCount: count };
  }

  /**
   * Delete an entity by `id`.
   *
   * @example
   *
   * ```ts
   * const deletedTodo = await this.service.deleteOne(1);
   * ```
   *
   * @param id - The `id` of the entity to delete.
   */
  async deleteOne(id: string | number): Promise<Entity> {
    const entity = await this.getById(id);
    await entity.destroy();
    return entity;
  }

  /**
   * Delete multiple records with a `@nestjs-query/core` `Filter`.
   *
   * @example
   *
   * ```ts
   * const { deletedCount } = this.service.deleteMany({
   *   created: { lte: new Date('2020-1-1') }
   * });
   * ```
   *
   * @param filter - A `Filter` to find records to delete.
   */
  async deleteMany(filter: Filter<Entity>): Promise<DeleteManyResponse> {
    const deletedCount = await this.model.destroy(this.filterQueryBuilder.destroyOptions({ filter }));
    return { deletedCount: deletedCount || 0 };
  }

  // eslint-disable-next-line @typescript-eslint/ban-types
  private getChangedValues(record: object): object {
    if (record instanceof this.model) {
      const recordEntity = (record as unknown) as Entity;
      const raw = recordEntity.get({ plain: true });
      const changed = recordEntity.changed();
      if (changed === false) {
        return {};
      }
      return lodashPick(raw, changed);
    }
    return record;
  }

  private async ensureEntityDoesNotExist(e: DeepPartial<Entity>): Promise<void> {
    const pks = this.primaryKeyValues(e);
    if (Object.keys(pks).length) {
      const found = await this.model.findOne({ where: pks });
      if (found) {
        throw new Error('Entity already exists');
      }
    }
  }

  private ensureIdIsNotPresent(e: DeepPartial<Entity>): void {
    if (Object.keys(this.primaryKeyValues(e)).length) {
      throw new Error('Id cannot be specified when updating');
    }
  }

  private primaryKeyValues(e: DeepPartial<Entity>): WhereOptions {
    const changed = this.getChangedValues(e) as Partial<Entity>;
    return this.model.primaryKeyAttributes.reduce((pks, pk) => {
      const key = pk as keyof Entity;
      if (key in changed && changed[key] !== undefined) {
        return { ...pks, [pk]: changed[key] } as WhereOptions;
      }
      return pks;
    }, {} as WhereOptions);
  }
}