#include "ConfigAppWeatherOccurrence.hpp"
#include "../../core/Filter.hpp"
#include "Exception.hpp"
#include "../../core/DataProvider.hpp"
#include "../../core/Utils.hpp"
#include "ConfigApp.hpp"
#include "ConfigAppWeatherTab.hpp"
#include "FilterDialog.hpp"
#include "ProjectionDialog.hpp"
#include "IntersectionDialog.hpp"

// TerraLib
#include <terralib/qt/widgets/srs/SRSManagerDialog.h>

// Qt
#include <QMessageBox>
#include <QUrl>

ConfigAppWeatherOccurrence::ConfigAppWeatherOccurrence(ConfigApp* app, Ui::ConfigAppForm* ui)
  : ConfigAppTab(app, ui), filter_(new terrama2::core::Filter)
{
  connect(ui_->serverInsertPointDiffBtn, SIGNAL(clicked()), SLOT(onDataSetBtnClicked()));
  connect(ui_->serverRemovePointDiffBtn, SIGNAL(clicked()), SLOT(onRemoveOccurrenceBtnClicked()));
  connect(ui_->filterPointDiffBtn, SIGNAL(clicked()), SLOT(onFilterClicked()));
  connect(ui_->projectionPointDiffBtn, SIGNAL(clicked()), SLOT(onProjectionClicked()));
  connect(ui_->intersectionBtn, SIGNAL(clicked()), SLOT(onIntersectionBtnClicked()));
  connect(ui_->pointDiffFormatDataName, SIGNAL(textEdited(QString)), SLOT(onSubTabEdited()));


  ui_->updateDataPointDiffBtn->setEnabled(false);
  ui_->exportDataPointDiffBtn->setEnabled(false);

  ui_->pointDiffFormatDataHour->setValidator(new QIntValidator(ui_->pointDiffFormatDataHour));
  ui_->pointDiffFormatDataMinute->setValidator(new QIntValidator(ui_->pointDiffFormatDataMinute));
  ui_->pointDiffFormatDataSecond->setValidator(new QIntValidator(ui_->pointDiffFormatDataSecond));

  ui_->pointDiffFormatDataTimeZoneCmb->setCurrentText("+00:00");
}

ConfigAppWeatherOccurrence::~ConfigAppWeatherOccurrence()
{

}

void ConfigAppWeatherOccurrence::load()
{
}

bool ConfigAppWeatherOccurrence::validate()
{
  if (ui_->pointDiffFormatDataName->text().trimmed().isEmpty())
  {
    ui_->pointDiffFormatDataName->setFocus();
    throw terrama2::gui::FieldError() << terrama2::ErrorDescription(tr("Occurence Name is invalid"));
  }

  if (ui_->pointDiffFormatDataMask->text().trimmed().isEmpty())
  {
    ui_->pointDiffFormatDataMask->setFocus();
    throw terrama2::gui::FieldError() << terrama2::ErrorDescription(tr("The occurrence data mask is invalid."));
  }

  //TODO: validate correctly all fields
  return true;
}

void ConfigAppWeatherOccurrence::save()
{
  terrama2::core::DataProvider provider = app_->getWeatherTab()->getProvider(ui_->weatherDataTree->currentItem()->text(0).toStdString());
  terrama2::core::DataSet dataset = app_->getWeatherTab()->getDataSet(selectedData_.toStdString());

  dataset.setName(ui_->pointDiffFormatDataName->text().toStdString());
  dataset.setKind(terrama2::core::DataSet::OCCURENCE_TYPE);
  dataset.setDescription(ui_->pointDiffFormatDataDescription->toPlainText().toStdString());

  te::dt::TimeDuration dataFrequency(ui_->pointDiffFormatDataHour->text().toInt(),
                                     ui_->pointDiffFormatDataMinute->text().toInt(),
                                     ui_->pointDiffFormatDataSecond->text().toInt());

  dataset.setDataFrequency(dataFrequency);

  std::map<std::string, std::string> metadata(dataset.metadata());
  metadata["UNIT"] = ui_->pointDiffFormatDataUnit->text().toStdString();
  metadata["KIND"] = ui_->pointDiffFormatDataFormat->currentText().toStdString();
  metadata["PREFIX"] = ui_->pointDiffFormatDataPrefix->text().toStdString();\
  dataset.setMetadata(metadata);

  dataset.setIntersection(intersection_);

  terrama2::core::DataSetItem* datasetItem;
  if (dataset.dataSetItems().size() > 0)
  {
    datasetItem = &dataset.dataSetItems()[dataset.dataSetItems().size() - 1];
    filter_->setDataSetItem(datasetItem->id());
  }
  else
    datasetItem = new terrama2::core::DataSetItem;

  std::map<std::string, std::string> storageMetadata;
  auto configuration = app_->getConfiguration();

  QUrl url(provider.uri().c_str());
  QString scheme = url.scheme().toLower();

  if (scheme == "file") // todo: check it and save an specific format
    storageMetadata["PATH"] = configuration->getCollection()->dirPath_.toStdString();

  else if (scheme == "http" || scheme == "https") // TODO: Http and OGC Services
  {
  }
  else if (scheme == "ftp") // TODO: ftp storage metadata
  {
  }
  else // postgis
  {
    storageMetadata["PG_HOST"] = configuration->getDatabase()->host_.toStdString();
    storageMetadata["PG_PORT"] = configuration->getDatabase()->port_;
    storageMetadata["PG_USER"] = configuration->getDatabase()->user_.toStdString();
    storageMetadata["PG_PASSWORD"] = configuration->getDatabase()->password_.toStdString();
    storageMetadata["PG_DB_NAME"] = configuration->getDatabase()->name_.toStdString();
    storageMetadata["PG_CLIENT_ENCODING"] = "UTF-8";
    storageMetadata["KIND"] = url.scheme().toStdString();
  }

  datasetItem->setStorageMetadata(storageMetadata);
  datasetItem->setSrid(srid_);

  terrama2::core::DataSetItem::Kind kind;
  int index = ui_->pointDiffFormatDataType->currentIndex();

  if (index == 0)
    kind = terrama2::core::DataSetItem::FIRE_POINTS_TYPE;
  else if (index == 1)
    kind = terrama2::core::DataSetItem::DISEASE_OCCURRENCE_TYPE;
  else
    kind = terrama2::core::DataSetItem::UNKNOWN_TYPE;

  datasetItem->setKind(kind);
  datasetItem->setPath(ui_->pointDiffFormatDataPath->text().toStdString());
  datasetItem->setMask(ui_->pointDiffFormatDataMask->text().toStdString());
  datasetItem->setTimezone(ui_->pointDiffFormatDataTimeZoneCmb->currentText().toStdString());
  datasetItem->setStatus(terrama2::core::ToDataSetItemStatus(ui_->pointDiffFormatStatus->isChecked()));

  datasetItem->setFilter(*filter_);

  if (datasetItem->id() == 0)
    dataset.add(*datasetItem);

  dataset.setStatus(terrama2::core::DataSet::ACTIVE);

  if (dataset.id() > 0)
  {
    app_->getClient()->updateDataSet(dataset);
    app_->getWeatherTab()->refreshList(ui_->weatherDataTree->currentItem(),
                                       selectedData_,
                                       ui_->pointDiffFormatDataName->text());
  }
  else
  {
    dataset.setProvider(provider.id());
    app_->getClient()->addDataSet(dataset);
    QTreeWidgetItem* item = new QTreeWidgetItem;
    item->setIcon(0, QIcon::fromTheme("ocurrence-data"));
    item->setText(0, ui_->pointDiffFormatDataName->text());
    ui_->weatherDataTree->currentItem()->addChild(item);
  }
  app_->getWeatherTab()->addCachedDataSet(dataset);
  changed_ = false;
}

void ConfigAppWeatherOccurrence::discardChanges(bool restore_data)
{
  for(QLineEdit* widget: ui_->DataPointDiffPage->findChildren<QLineEdit*>())
    widget->clear();
  changed_ = false;

  filter_.reset(new terrama2::core::Filter);

  ui_->pointDiffFormatDataDescription->setText("");
  ui_->pointDiffFormatDataTimeZoneCmb->setCurrentText("+00:00");

  resetFilterState();
}

void ConfigAppWeatherOccurrence::fillFilter(const terrama2::core::Filter& filter)
{
  filter_.reset(new terrama2::core::Filter(filter));

  if (filter.discardBefore() != nullptr || filter.discardAfter() != nullptr)
    ui_->dateFilterPointDiffLabel->setText(tr("Yes"));
  else
    ui_->dateFilterPointDiffLabel->setText(tr("No"));

  if (filter.geometry() != nullptr)
    ui_->areaFilterPointDiffLabel->setText(tr("Yes"));
  else
    ui_->areaFilterPointDiffLabel->setText(tr("No"));
}

void ConfigAppWeatherOccurrence::resetFilterState()
{
  ui_->dateFilterPointDiffLabel->setText(tr("No"));
  ui_->areaFilterPointDiffLabel->setText(tr("No"));
}

void ConfigAppWeatherOccurrence::onFilterClicked()
{
  FilterDialog dialog(FilterDialog::DATE, ui_->pointDiffFormatDataTimeZoneCmb->currentText(), app_);
  dialog.fillGUI(*filter_);
  if (dialog.exec() == QDialog::Accepted)
    dialog.fillObject(*filter_);

  if (dialog.isFilterByDate())
    ui_->dateFilterPointDiffLabel->setText(tr("Yes"));
  else
    ui_->dateFilterPointDiffLabel->setText(tr("No"));

  if (dialog.isFilterByArea())
    ui_->areaFilterPointDiffLabel->setText(tr("Yes"));
  else
    ui_->areaFilterPointDiffLabel->setText(tr("No"));
}

void ConfigAppWeatherOccurrence::onDataSetBtnClicked()
{
  if (ui_->weatherDataTree->currentItem() != nullptr &&
      ui_->weatherDataTree->currentItem()->parent() != nullptr &&
      ui_->weatherDataTree->currentItem()->parent()->parent() == nullptr)
  {
    selectedData_.clear();
    app_->getWeatherTab()->changeTab(*this, *ui_->DataPointDiffPage);

    intersection_ = terrama2::core::Intersection();
    filter_.reset(new terrama2::core::Filter);
    resetFilterState();
  }
  else
    QMessageBox::warning(app_, tr("TerraMA2 Data Set"), tr("Please select a data provider to the new dataset"));
}

void ConfigAppWeatherOccurrence::onRemoveOccurrenceBtnClicked()
{
  QTreeWidgetItem* currentItem = ui_->weatherDataTree->currentItem();
  if (currentItem != nullptr && currentItem->parent() != nullptr && currentItem->parent()->parent() != nullptr)
  {
    try
    {
      terrama2::core::DataSet dataset = app_->getWeatherTab()->getDataSet(currentItem->text(0).toStdString());

      if (removeDataSet(dataset))
      {
        app_->getClient()->removeDataSet(dataset.id());
        app_->getWeatherTab()->removeCachedDataSet(dataset);

        QMessageBox::information(app_, tr("TerraMA2"), tr("DataSet Occurrence successfully removed!"));
        delete currentItem;
      }
    }
    catch(const terrama2::Exception& e)
    {
      const QString* message = boost::get_error_info<terrama2::ErrorDescription>(e);
      QMessageBox::warning(app_, tr("TerraMA2"), *message);
    }
  }
  ui_->cancelBtn->clicked();
}

void ConfigAppWeatherOccurrence::onIntersectionBtnClicked()
{
  IntersectionDialog dialog(intersection_, app_->getConfiguration()->getDatabase());
  if(dialog.exec() == QDialog::Accepted)
  {
    intersection_ = dialog.getIntersection();
  }
}

void ConfigAppWeatherOccurrence::onProjectionClicked()
{
  te::qt::widgets::SRSManagerDialog srsDialog(app_);
  srsDialog.setWindowTitle(tr("Choose the SRS"));

  if (srsDialog.exec() == QDialog::Rejected)
    return;


  srid_ = (uint64_t) srsDialog.getSelectedSRS().first;

}

void ConfigAppWeatherOccurrence::setIntersection(const terrama2::core::Intersection& intersection)
{
  intersection_ = intersection;
}

void ConfigAppWeatherOccurrence::setSrid(const uint64_t srid)
{
  srid_ = srid;
}
